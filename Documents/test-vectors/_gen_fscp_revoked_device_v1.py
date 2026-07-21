"""One-off generator for fscp-revoked-device-v1.json — run: python _gen_fscp_revoked_device_v1.py

Golden transcript `message_session_revoked_device_v1_failure`
(Documents/fscp/FSCP.md §Device revocation; e2e-security.md §Compliance):
цепочка session 1:1 → encrypt M1 → decrypt на peer → POST .../devices/{id}/revoke
отправителя → M2 (и повтор M1) с тем же device id отклоняются policy-слоем.

Криптографически wire отозванного устройства остаётся валидным (подпись/AEAD
не знают о статусе) — вектор фиксирует, что отказ обязан приходить из policy:
сервер (fscp_core::REVOKED_SENDER_DEVICE_ERROR + is_sender_device_revoked),
клиент (evaluateInboundSenderDevice + canSendOutbound/noteOutboundAccepted).
Детерминирован. Consumers: TS revokedDeviceVector.test.ts (@flora/fscp),
Rust fscp_revoked_device_vectors.rs (flora-parity).
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

LABEL = b"fscp_revoked_device_v1"

SENDER = "55555555-5555-4555-8555-555555555555"
RECEIVER = "77777777-7777-4777-8777-777777777777"
KEY_EPOCH = "00000000-0000-4000-8000-000000000001"  # bootstrap (FSCP v1)
SENDER_DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
RECEIVER_DEVICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"

SIGNING_CONTEXT = "flora.messaging.envelope-signature.v1"

MESSAGES = {
    "m1": {
        "messageUuid": "33333333-3333-4333-8333-333333333331",
        "messageKeyId": "44444444-4444-4444-8444-444444444441",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "text": "До revoke: сессия ready 🌸",
    },
    "m2": {
        "messageUuid": "33333333-3333-4333-8333-333333333332",
        "messageKeyId": "44444444-4444-4444-8444-444444444442",
        "createdAt": "2026-01-01T00:10:00.000Z",
        "text": "После revoke: этот wire обязан быть отклонён policy-слоем",
    },
}

SERVER_POLICY_ERROR = "FSCP wire: senderDeviceUuid отозван — требуется re-handshake с активным устройством."
CLIENT_OUTBOUND_ERROR = "FSCP session: исходящие приостановлены до re-handshake (compromised_local)."


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def seed(label: str) -> bytes:
    return hashlib.sha256(LABEL + b"|" + label.encode()).digest()


def compact(o) -> str:
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False)


def canonical(o) -> str:
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def dm_conversation_uuid(a: str, b: str) -> str:
    x, y = sorted((a.lower(), b.lower()))
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{x}|{y}|fscp-dm-v1"))


def agreement_public_key_id(user: str, epoch: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{user.lower()}|{epoch.lower()}|agreement-v1"))


def x25519_keypair(priv_seed: bytes):
    priv = x25519.X25519PrivateKey.from_private_bytes(priv_seed)
    return priv, priv.public_key().public_bytes_raw()


def main() -> None:
    conversation = dm_conversation_uuid(SENDER, RECEIVER)

    sender_ag_seed = seed("sender_agreement")
    receiver_ag_seed = seed("receiver_agreement")
    _, sender_ag_pub = x25519_keypair(sender_ag_seed)
    _, receiver_ag_pub = x25519_keypair(receiver_ag_seed)
    signing_seed = seed("sender_signing_seed")
    signing_key = SigningKey(signing_seed)
    signing_pub = bytes(signing_key.verify_key)

    device_of = {SENDER: SENDER_DEVICE, RECEIVER: RECEIVER_DEVICE}
    ag_pub_of = {SENDER: sender_ag_pub, RECEIVER: receiver_ag_pub}

    def rke_aad(m: dict, recipient_user: str, pk_id: str) -> str:
        return " | ".join([
            "flora.messaging.recipient-key-envelope.v1",
            conversation.lower(), KEY_EPOCH.lower(),
            m["messageUuid"].lower(), m["messageKeyId"].lower(),
            SENDER.lower(), SENDER_DEVICE.lower(),
            recipient_user.lower(), device_of[recipient_user].lower(), pk_id.lower(),
        ])

    def body_aad(m: dict) -> str:
        return " | ".join([
            "flora.messaging.message.v1",
            conversation.lower(), KEY_EPOCH.lower(),
            m["messageUuid"].lower(), m["messageKeyId"].lower(),
            SENDER.lower(), SENDER_DEVICE.lower(), m["createdAt"],
        ])

    def build_message(mid: str):
        m = MESSAGES[mid]
        message_key = seed(f"message_key|{mid}")
        body_nonce = seed(f"body_nonce|{mid}")[:24]
        plaintext_obj = {
            "type": "blocks",
            "version": 1,
            "blocks": [{"kind": "text", "body": m["text"]}],
            "clientCreatedAt": m["createdAt"],
        }
        plaintext_utf8 = compact(plaintext_obj)
        body_aad_line = body_aad(m)
        body_ct = nacl_bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
            plaintext_utf8.encode("utf-8"), body_aad_line.encode("utf-8"), body_nonce, message_key,
        )

        def one_rke(recipient_user: str):
            pk_id = agreement_public_key_id(recipient_user, KEY_EPOCH)
            aad_line = rke_aad(m, recipient_user, pk_id)
            eph_seed = seed(f"ephemeral|{mid}|{recipient_user.lower()}")
            eph_priv, eph_pub = x25519_keypair(eph_seed)
            salt = seed(f"salt|{mid}|{recipient_user.lower()}")
            ss = eph_priv.exchange(x25519.X25519PublicKey.from_public_bytes(ag_pub_of[recipient_user]))
            wrap_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=aad_line.encode("utf-8")).derive(ss)
            nonce = seed(f"rke_nonce|{mid}|{recipient_user.lower()}")[:24]
            ct = nacl_bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
                message_key, aad_line.encode("utf-8"), nonce, wrap_key)
            return {
                "userUuid": recipient_user,
                "deviceUuid": device_of[recipient_user],
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

        recipients = sorted(
            [one_rke(SENDER), one_rke(RECEIVER)],
            key=lambda r: (r["userUuid"].lower(), r["deviceUuid"].lower()),
        )
        envelope_no_sig = {
            "version": 1,
            "messageUuid": m["messageUuid"],
            "conversationUuid": conversation,
            "keyEpochId": KEY_EPOCH,
            "senderUserUuid": SENDER,
            "senderDeviceUuid": SENDER_DEVICE,
            "messageKeyId": m["messageKeyId"],
            "createdAt": m["createdAt"],
            "ciphertextBase64Url": b64u(body_ct),
            "aead": {"name": "xchacha20-poly1305", "nonceBase64Url": b64u(body_nonce)},
            "recipients": recipients,
            "senderSigningPublicKeyBase64Url": b64u(signing_pub),
        }
        signing_payload = f"{SIGNING_CONTEXT} | {canonical(envelope_no_sig)}"
        signature = signing_key.sign(signing_payload.encode("utf-8")).signature
        full = dict(envelope_no_sig)
        full["senderSignatureBase64Url"] = b64u(signature)
        return {
            "messageUuid": m["messageUuid"],
            "messageKeyId": m["messageKeyId"],
            "createdAt": m["createdAt"],
            "text": m["text"],
            "plaintextUtf8": plaintext_utf8,
            "messageKeyBase64Url": b64u(message_key),
            "bodyAadUtf8": body_aad_line,
            "canonicalSigningPayloadUtf8": signing_payload,
            "wire": "fscp1:" + b64u(compact(full).encode("utf-8")),
        }

    device_set_before = [
        {"deviceUuid": SENDER_DEVICE, "userUuid": SENDER, "status": "Active"},
        {"deviceUuid": RECEIVER_DEVICE, "userUuid": RECEIVER, "status": "Active"},
    ]
    device_set_after = [
        {"deviceUuid": SENDER_DEVICE, "userUuid": SENDER, "status": "Revoked"},
        {"deviceUuid": RECEIVER_DEVICE, "userUuid": RECEIVER, "status": "Active"},
    ]

    out = {
        "vectorId": "message_session_revoked_device_v1_failure",
        "fscpProtocolVersion": 1,
        "description": (
            "Транскрипт revoke-сценария: M1 до revoke обрабатывается (сессия ready), затем "
            "POST .../devices/{senderDeviceUuid}/revoke; M2 (и повтор M1) от того же устройства "
            "криптографически валидны, но обязаны отклоняться policy-слоем сервера и клиента; "
            "исходящие блокируются session FSM до re-handshake."
        ),
        "uuids": {
            "senderUserUuid": SENDER,
            "receiverUserUuid": RECEIVER,
            "conversationUuid": conversation,
            "keyEpochId": KEY_EPOCH,
            "senderDeviceUuid": SENDER_DEVICE,
            "receiverDeviceUuid": RECEIVER_DEVICE,
            "senderAgreementPublicKeyId": agreement_public_key_id(SENDER, KEY_EPOCH),
            "receiverAgreementPublicKeyId": agreement_public_key_id(RECEIVER, KEY_EPOCH),
        },
        "keys": {
            "senderAgreementPrivateKeyBase64Url": b64u(sender_ag_seed),
            "senderAgreementPublicKeyBase64Url": b64u(sender_ag_pub),
            "receiverAgreementPrivateKeyBase64Url": b64u(receiver_ag_seed),
            "receiverAgreementPublicKeyBase64Url": b64u(receiver_ag_pub),
            "senderSigningSeedBase64Url": b64u(signing_seed),
            "senderSigningSecretKeyBase64Url": b64u(signing_seed + signing_pub),
            "senderSigningPublicKeyBase64Url": b64u(signing_pub),
        },
        "messageBeforeRevoke": build_message("m1"),
        "revokeEvent": {
            "httpMethod": "POST",
            "pathTemplate": "/api/messaging/e2e/epochs/{keyEpochId}/devices/{senderDeviceUuid}/revoke",
        },
        "messageAfterRevoke": build_message("m2"),
        "deviceSetBeforeRevoke": device_set_before,
        "deviceSetAfterRevoke": device_set_after,
        "expected": {
            "beforeRevoke": {
                "serverFormValidation": "accept",
                "serverEnvelopeSignature": "ok",
                "serverDevicePolicy": "allow",
                "clientPeerDecrypt": "ok",
                "clientSessionStateAfterInbound": "ready",
            },
            "afterRevoke": {
                "serverFormValidation": "accept",
                "serverEnvelopeSignature": "ok",
                "serverDevicePolicy": "reject",
                "serverDevicePolicyError": SERVER_POLICY_ERROR,
                "clientInboundPolicy": "reject",
                "clientSessionState": "compromised_local",
                "clientCompromiseReason": "device_revoked",
                "clientOutboundBlocked": True,
                "clientOutboundError": CLIENT_OUTBOUND_ERROR,
                "cryptoBypassDecrypt": "ok",
                "cryptoBypassNote": (
                    "Подпись и AEAD не знают о статусе устройства: отказ обязан приходить из "
                    "policy-слоя (server device policy / client inbound policy), не из криптографии."
                ),
            },
        },
    }

    path = Path(__file__).with_name("fscp-revoked-device-v1.json")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", path)


if __name__ == "__main__":
    main()
