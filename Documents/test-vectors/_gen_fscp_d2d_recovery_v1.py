"""One-off generator for fscp-d2d-recovery-v1.json — run: python _gen_fscp_d2d_recovery_v1.py

DeviceToDeviceRecoveryEnvelope (Documents/fscp/e2e-security.md §DeviceToDeviceRecoveryEnvelope):
payload JSON → X25519(eph, target agreement pk) → HKDF-SHA256(salt32, info=AAD) →
XChaCha20-Poly1305(aad=AAD) → canonical JSON без подписи → Ed25519 подпись source device.
Детерминирован (все "случайные" байты — SHA-256 от фиксированных меток).
Consumers: TS d2dRecoveryVector.test.ts (@flora/fscp), Rust fscp_d2d_recovery_vectors.rs
(server-side validate + signature verify, fscp-core).
"""
import base64
import copy
import hashlib
import json
import uuid
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from nacl import bindings as nacl_bindings
from nacl.signing import SigningKey

LABEL = b"fscp_d2d_recovery_v1"

USER = "55555555-5555-4555-8555-555555555555"
SOURCE_DEVICE = "66666666-6666-4666-8666-666666666666"
TARGET_DEVICE = "77777777-7777-4777-8777-777777777777"
RECOVERY_REQUEST = "88888888-8888-4888-8888-888888888888"
EPOCH_A = "11111111-1111-4111-8111-111111111111"
EPOCH_B = "22222222-2222-4222-8222-222222222222"

AAD_DOMAIN = "flora.messaging.device-to-device-recovery.v1"
SIGNATURE_DOMAIN = "flora.messaging.device-to-device-recovery-signature.v1"


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


def device_agreement_public_key_id(user: str, device: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{user.lower()}|{device.lower()}|device-agreement-v1"))


def x25519_keypair(priv_seed: bytes):
    priv = x25519.X25519PrivateKey.from_private_bytes(priv_seed)
    return priv, priv.public_key().public_bytes_raw()


def sign_envelope(env_no_sig: dict, signing_key: SigningKey) -> str:
    payload = f"{SIGNATURE_DOMAIN} | {canonical(env_no_sig)}"
    return b64u(signing_key.sign(payload.encode("utf-8")).signature)


def main() -> None:
    target_ag_priv_seed = seed("target_agreement")
    target_ag_priv, target_ag_pub = x25519_keypair(target_ag_priv_seed)
    eph_seed = seed("ephemeral")
    eph_priv, eph_pub = x25519_keypair(eph_seed)
    salt = seed("salt")
    nonce = seed("nonce")[:24]

    source_signing_seed = seed("source_signing_seed")
    source_signing = SigningKey(source_signing_seed)
    source_signing_pub = bytes(source_signing.verify_key)
    foreign_signing = SigningKey(seed("foreign_signing_seed"))

    transferred = sorted([EPOCH_A.lower(), EPOCH_B.lower()])
    target_agreement_id = device_agreement_public_key_id(USER, TARGET_DEVICE)

    payload_obj = {
        "keyEpochs": [
            {
                "keyEpochId": epoch,
                "rootKeyBase64Url": b64u(seed(f"root_key|{epoch}")),
                "epochAccountIdentityPrivateKeyBase64Url": b64u(seed(f"epoch_identity_seed|{epoch}")),
                "epochAccountIdentityPublicKeyBase64Url": b64u(
                    bytes(SigningKey(seed(f"epoch_identity_seed|{epoch}")).verify_key)
                ),
                "conversationKeyBackups": [],
            }
            for epoch in transferred
        ]
    }
    payload_utf8 = compact(payload_obj)

    aad = " | ".join([
        AAD_DOMAIN,
        RECOVERY_REQUEST.lower(),
        USER.lower(),
        SOURCE_DEVICE.lower(),
        TARGET_DEVICE.lower(),
        target_agreement_id.lower(),
        ",".join(transferred),
    ])

    ss = eph_priv.exchange(x25519.X25519PublicKey.from_public_bytes(target_ag_pub))
    wrap_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=aad.encode("utf-8")).derive(ss)
    ciphertext = nacl_bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
        payload_utf8.encode("utf-8"), aad.encode("utf-8"), nonce, wrap_key
    )

    env_no_sig = {
        "version": 1,
        "recoveryRequestId": RECOVERY_REQUEST.lower(),
        "userUuid": USER.lower(),
        "sourceDeviceUuid": SOURCE_DEVICE.lower(),
        "targetDeviceUuid": TARGET_DEVICE.lower(),
        "transferredKeyEpochIds": transferred,
        "targetAgreementPublicKeyId": target_agreement_id,
        "ephemeralPublicKeyBase64Url": b64u(eph_pub),
        "saltBase64Url": b64u(salt),
        "aead": {"name": "xchacha20-poly1305", "nonceBase64Url": b64u(nonce)},
        "ciphertextBase64Url": b64u(ciphertext),
    }
    canonical_signing_payload = f"{SIGNATURE_DOMAIN} | {canonical(env_no_sig)}"
    envelope = dict(env_no_sig)
    envelope["sourceDeviceSignatureBase64Url"] = sign_envelope(env_no_sig, source_signing)

    # ── Негативы ─────────────────────────────────────────────────────────────
    # 1. Подмена recoveryRequestId после подписи: server → signature, client → binding.
    wrong_challenge = copy.deepcopy(envelope)
    wrong_challenge["recoveryRequestId"] = "99999999-9999-4999-8999-999999999999"

    # 2. Порча ciphertext после подписи: подпись покрывает ciphertext.
    tampered_ct = bytearray(ciphertext)
    tampered_ct[0] ^= 0x01
    tampered_ciphertext = copy.deepcopy(envelope)
    tampered_ciphertext["ciphertextBase64Url"] = b64u(bytes(tampered_ct))

    # 3. Подпись чужим ключом (форма валидна, canonical тот же).
    foreign_signature = copy.deepcopy(envelope)
    foreign_signature["sourceDeviceSignatureBase64Url"] = sign_envelope(env_no_sig, foreign_signing)

    # 4. Пустой transferredKeyEpochIds, переподписан подлинным ключом:
    #    падает структурная валидация, не подпись.
    empty_epochs_no_sig = copy.deepcopy(env_no_sig)
    empty_epochs_no_sig["transferredKeyEpochIds"] = []
    empty_epochs = dict(empty_epochs_no_sig)
    empty_epochs["sourceDeviceSignatureBase64Url"] = sign_envelope(empty_epochs_no_sig, source_signing)

    out = {
        "vectorId": "device_to_device_recovery_envelope_v1",
        "fscpProtocolVersion": 1,
        "aadDomain": AAD_DOMAIN,
        "signatureDomain": SIGNATURE_DOMAIN,
        "uuids": {
            "userUuid": USER.lower(),
            "sourceDeviceUuid": SOURCE_DEVICE.lower(),
            "targetDeviceUuid": TARGET_DEVICE.lower(),
            "recoveryRequestId": RECOVERY_REQUEST.lower(),
            "transferredKeyEpochIds": transferred,
            "targetAgreementPublicKeyId": target_agreement_id,
        },
        "keys": {
            "sourceSigningSeedBase64Url": b64u(source_signing_seed),
            "sourceSigningPublicKeyBase64Url": b64u(source_signing_pub),
            "foreignSigningPublicKeyBase64Url": b64u(bytes(foreign_signing.verify_key)),
            "targetAgreementPrivateKeyBase64Url": b64u(target_ag_priv_seed),
            "targetAgreementPublicKeyBase64Url": b64u(target_ag_pub),
            "ephemeralPrivateKeyBase64Url": b64u(eph_seed),
            "ephemeralPublicKeyBase64Url": b64u(eph_pub),
        },
        "aadUtf8": aad,
        "payloadPlaintextUtf8": payload_utf8,
        "x25519SharedSecretBase64Url": b64u(ss),
        "hkdfSaltBase64Url": b64u(salt),
        "wrapKeyBase64Url": b64u(wrap_key),
        "canonicalSigningPayloadUtf8": canonical_signing_payload,
        "envelope": envelope,
        "cases": [
            {
                "caseId": "device_to_device_recovery_envelope_v1_success",
                "envelope": envelope,
                "expectedServer": "ok",
                "expectedClient": "ok",
            },
            {
                "caseId": "device_to_device_recovery_envelope_v1_wrong_challenge",
                "envelope": wrong_challenge,
                "expectedServer": "error",
                "expectedServerError": "D2D recovery: подпись source-устройства не прошла проверку.",
                "expectedClientErrorCategory": "binding_mismatch",
            },
            {
                "caseId": "device_to_device_recovery_envelope_v1_tampered_ciphertext",
                "envelope": tampered_ciphertext,
                "expectedServer": "error",
                "expectedServerError": "D2D recovery: подпись source-устройства не прошла проверку.",
                "expectedClientErrorCategory": "signature_invalid",
            },
            {
                "caseId": "device_to_device_recovery_envelope_v1_foreign_signature",
                "envelope": foreign_signature,
                "expectedServer": "error",
                "expectedServerError": "D2D recovery: подпись source-устройства не прошла проверку.",
                "expectedClientErrorCategory": "signature_invalid",
            },
            {
                "caseId": "device_to_device_recovery_envelope_v1_empty_epochs",
                "envelope": empty_epochs,
                "expectedServer": "error",
                "expectedServerError": "D2D recovery: transferredKeyEpochIds должен быть непустым массивом.",
                "expectedClientErrorCategory": "malformed_envelope",
            },
        ],
    }
    path = Path(__file__).with_name("fscp-d2d-recovery-v1.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", path)


if __name__ == "__main__":
    main()
