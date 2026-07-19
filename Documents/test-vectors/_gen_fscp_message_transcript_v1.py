"""One-off generator for fscp-message-transcript-v1.json — run: python _gen_fscp_message_transcript_v1.py

Полный E2E-транскрипт FSCP v1 (Documents/fscp/FSCP.md §Algorithms, Algorithm A):
plaintext → body AEAD → RKE x2 → canonical JSON → Ed25519 → fscp1:-wire.
Детерминирован (все "случайные" байты — SHA-256 от фиксированных меток).
Consumers: TS transcriptVector.test.ts, Rust fscp_transcript_vectors.rs,
C# FscpWireValidatorVectors.cs (форма wire).
"""
import base64
import hashlib
import json
import uuid
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from nacl import bindings as nacl_bindings
from nacl.signing import SigningKey

LABEL = b"fscp_message_transcript_v1"

SENDER = "55555555-5555-4555-8555-555555555555"
RECEIVER = "77777777-7777-4777-8777-777777777777"
KEY_EPOCH = "00000000-0000-4000-8000-000000000001"  # bootstrap (FSCP v1)
DEVICE = "00000000-0000-4000-8000-000000000002"  # bootstrap device sentinel
MESSAGE_UUID = "33333333-3333-4333-8333-333333333333"
MESSAGE_KEY_ID = "44444444-4444-4444-8444-444444444444"
CREATED_AT = "2026-01-01T00:00:00.000Z"
TEXT = "Привет, FSCP! 🌸"

SIGNING_CONTEXT = "flora.messaging.envelope-signature.v1"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def seed(label: str) -> bytes:
    return hashlib.sha256(LABEL + b"|" + label.encode()).digest()


def compact(o) -> str:
    """JSON.stringify: порядок вставки, без пробелов, non-ASCII не экранируется."""
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False)


def canonical(o) -> str:
    """canonicalJson: рекурсивная сортировка ключей по code unit (для ASCII = code point)."""
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def dm_conversation_uuid(a: str, b: str) -> str:
    x, y = sorted((a.lower(), b.lower()))
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{x}|{y}|fscp-dm-v1"))


def agreement_public_key_id(user: str, epoch: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{user.lower()}|{epoch.lower()}|agreement-v1"))


def rke_aad(conversation: str, recipient_user: str, recipient_device: str, pk_id: str) -> str:
    return " | ".join([
        "flora.messaging.recipient-key-envelope.v1",
        conversation.lower(), KEY_EPOCH.lower(), MESSAGE_UUID.lower(), MESSAGE_KEY_ID.lower(),
        SENDER.lower(), DEVICE.lower(), recipient_user.lower(), recipient_device.lower(), pk_id.lower(),
    ])


def body_aad(conversation: str) -> str:
    return " | ".join([
        "flora.messaging.message.v1",
        conversation.lower(), KEY_EPOCH.lower(), MESSAGE_UUID.lower(), MESSAGE_KEY_ID.lower(),
        SENDER.lower(), DEVICE.lower(), CREATED_AT,
    ])


def x25519_keypair(priv_seed: bytes):
    priv = x25519.X25519PrivateKey.from_private_bytes(priv_seed)
    return priv, priv.public_key().public_bytes_raw()


def build_wire(envelope: dict) -> str:
    return "fscp1:" + b64u(compact(envelope).encode("utf-8"))


def main() -> None:
    conversation = dm_conversation_uuid(SENDER, RECEIVER)

    sender_ag_priv, sender_ag_pub = x25519_keypair(seed("sender_agreement"))
    receiver_ag_priv, receiver_ag_pub = x25519_keypair(seed("receiver_agreement"))
    signing_seed = seed("sender_signing_seed")
    signing_key = SigningKey(signing_seed)
    signing_pub = bytes(signing_key.verify_key)

    message_key = seed("message_key")
    body_nonce = seed("body_nonce")[:24]
    body_aad_line = body_aad(conversation)
    plaintext_obj = {
        "type": "blocks",
        "version": 1,
        "blocks": [{"kind": "text", "body": TEXT}],
        "clientCreatedAt": CREATED_AT,
    }
    plaintext_utf8 = compact(plaintext_obj)
    body_ct = nacl_bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext_utf8.encode("utf-8"), body_aad_line.encode("utf-8"), body_nonce, message_key,
    )

    def one_rke(recipient_user: str, recipient_ag_pub: bytes):
        pk_id = agreement_public_key_id(recipient_user, KEY_EPOCH)
        aad_line = rke_aad(conversation, recipient_user, DEVICE, pk_id)
        eph_seed = seed(f"ephemeral|{recipient_user.lower()}")
        eph_priv, eph_pub = x25519_keypair(eph_seed)
        salt = seed(f"salt|{recipient_user.lower()}")
        ss = eph_priv.exchange(x25519.X25519PublicKey.from_public_bytes(recipient_ag_pub))
        wrap_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=aad_line.encode("utf-8")).derive(ss)
        nonce = seed(f"rke_nonce|{recipient_user.lower()}")[:24]
        ct = nacl_bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(message_key, aad_line.encode("utf-8"), nonce, wrap_key)
        row = {
            "userUuid": recipient_user,
            "deviceUuid": DEVICE,
            "recipientKeyEnvelope": {
                "version": 1,
                "algorithm": "x25519-hkdf-xchacha20poly1305",
                "ephemeralPublicKeyBase64Url": b64u(eph_pub),
                "recipientAgreementPublicKeyId": pk_id,
                "preKeyId": None,
                "saltBase64Url": b64u(salt),
                "aead": {"name": "xchacha20-poly1305", "nonceBase64Url": b64u(nonce)},
                "ciphertextBase64Url": b64u(ct),
            },
        }
        debug = {
            "userUuid": recipient_user,
            "deviceUuid": DEVICE,
            "aadUtf8": aad_line,
            "ephemeralPrivateKeyBase64Url": b64u(eph_seed),
            "ephemeralPublicKeyBase64Url": b64u(eph_pub),
            "saltBase64Url": b64u(salt),
            "x25519SharedSecretBase64Url": b64u(ss),
            "wrapKeyBase64Url": b64u(wrap_key),
            "nonceBase64Url": b64u(nonce),
            "ciphertextBase64Url": b64u(ct),
        }
        return row, debug

    row_receiver, dbg_receiver = one_rke(RECEIVER, receiver_ag_pub)
    row_sender, dbg_sender = one_rke(SENDER, sender_ag_pub)
    order = sorted([(row_sender, dbg_sender), (row_receiver, dbg_receiver)],
                   key=lambda p: (p[0]["userUuid"].lower(), p[0]["deviceUuid"].lower()))
    recipients = [p[0] for p in order]
    recipients_debug = [p[1] for p in order]

    envelope_no_sig = {
        "version": 1,
        "messageUuid": MESSAGE_UUID,
        "conversationUuid": conversation,
        "keyEpochId": KEY_EPOCH,
        "senderUserUuid": SENDER,
        "senderDeviceUuid": DEVICE,
        "messageKeyId": MESSAGE_KEY_ID,
        "createdAt": CREATED_AT,
        "ciphertextBase64Url": b64u(body_ct),
        "aead": {"name": "xchacha20-poly1305", "nonceBase64Url": b64u(body_nonce)},
        "recipients": recipients,
        "senderSigningPublicKeyBase64Url": b64u(signing_pub),
    }
    signing_payload = f"{SIGNING_CONTEXT} | {canonical(envelope_no_sig)}"
    signature = signing_key.sign(signing_payload.encode("utf-8")).signature
    full = dict(envelope_no_sig)
    full["senderSignatureBase64Url"] = b64u(signature)
    envelope_json = compact(full)
    wire = "fscp1:" + b64u(envelope_json.encode("utf-8"))

    # --- варианты ---
    tampered_sig = bytearray(signature)
    tampered_sig[0] ^= 0x01
    tampered = dict(envelope_no_sig)
    tampered["senderSignatureBase64Url"] = b64u(bytes(tampered_sig))

    legacy = {k: v for k, v in full.items()
              if k not in ("senderSigningPublicKeyBase64Url", "senderSignatureBase64Url")}

    out = {
        "vectorId": "fscp_message_transcript_v1",
        "fscpProtocolVersion": 1,
        "messageEnvelopeVersion": 1,
        "description": (
            "Полный транскрипт 1:1 сообщения FSCP v1: plaintext → body AEAD → RKE (оба получателя) → "
            "canonical JSON → Ed25519 → fscp1:-wire. Байт-в-байт паритет обязателен для TS-клиента "
            "(decryptFscpWireEnvelope), Rust (canonical_json + RustCrypto + валидатор формы) и C#-валидатора формы."
        ),
        "uuids": {
            "senderUserUuid": SENDER,
            "receiverUserUuid": RECEIVER,
            "conversationUuid": conversation,
            "keyEpochId": KEY_EPOCH,
            "senderDeviceUuid": DEVICE,
            "receiverDeviceUuid": DEVICE,
            "messageUuid": MESSAGE_UUID,
            "messageKeyId": MESSAGE_KEY_ID,
            "senderAgreementPublicKeyId": agreement_public_key_id(SENDER, KEY_EPOCH),
            "receiverAgreementPublicKeyId": agreement_public_key_id(RECEIVER, KEY_EPOCH),
        },
        "createdAt": CREATED_AT,
        "text": TEXT,
        "plaintextUtf8": plaintext_utf8,
        "keys": {
            "senderAgreementPrivateKeyBase64Url": b64u(seed("sender_agreement")),
            "senderAgreementPublicKeyBase64Url": b64u(sender_ag_pub),
            "receiverAgreementPrivateKeyBase64Url": b64u(seed("receiver_agreement")),
            "receiverAgreementPublicKeyBase64Url": b64u(receiver_ag_pub),
            "senderSigningSeedBase64Url": b64u(signing_seed),
            "senderSigningSecretKeyBase64Url": b64u(signing_seed + signing_pub),
            "senderSigningPublicKeyBase64Url": b64u(signing_pub),
            "messageKeyBase64Url": b64u(message_key),
        },
        "body": {
            "aadUtf8": body_aad_line,
            "nonceBase64Url": b64u(body_nonce),
            "ciphertextBase64Url": b64u(body_ct),
        },
        "recipients": recipients_debug,
        "canonicalSigningPayloadUtf8": signing_payload,
        "signatureBase64Url": b64u(signature),
        "envelopeJsonUtf8": envelope_json,
        "wire": wire,
        "variants": [
            {
                "variantId": "signature_tampered",
                "description": "Бит подписи инвертирован; форма валидна (сервер v1 крипто не проверяет — Known limitations), клиент обязан отклонить.",
                "wire": build_wire(tampered),
                "clientDecrypt": "reject-signature",
                "serverFormValidation": "accept",
            },
            {
                "variantId": "legacy_unsigned",
                "description": "Конверт без signing pk и подписи: клиент отклоняет по умолчанию (downgrade-защита, errata-5); чтение архива — только явный opt-in allowUnsignedLegacy. Сервер такие wire отклоняет.",
                "wire": build_wire(legacy),
                "clientDecrypt": "reject-unsigned",
                "serverFormValidation": "reject",
                "serverExpectedError": "FSCP wire: требуется senderSigningPublicKeyBase64Url (Ed25519, 32 байта).",
            },
        ],
    }

    path = Path(__file__).with_name("fscp-message-transcript-v1.json")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", path)


if __name__ == "__main__":
    main()
