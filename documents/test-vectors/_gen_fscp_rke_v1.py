"""One-off generator for fscp-rke-wrap-key-v1.json — run: python _gen_fscp_rke_v1.py"""
import hashlib
import json
import base64
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from nacl import bindings as nacl_bindings


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def main() -> None:
    seed_a = hashlib.sha256(b"fscp_rke_wrap_key_v1|alice_ephemeral").digest()
    seed_b = hashlib.sha256(b"fscp_rke_wrap_key_v1|bob_agreement").digest()
    alice_eph = x25519.X25519PrivateKey.from_private_bytes(seed_a)
    bob_ag = x25519.X25519PrivateKey.from_private_bytes(seed_b)
    ss = alice_eph.exchange(bob_ag.public_key())

    uu = {
        "conversationUuid": "11111111-1111-4111-8111-111111111111",
        "keyEpochId": "22222222-2222-4222-8222-222222222222",
        "messageUuid": "33333333-3333-4333-8333-333333333333",
        "messageKeyId": "44444444-4444-4444-8444-444444444444",
        "senderUserUuid": "55555555-5555-4555-8555-555555555555",
        "senderDeviceUuid": "66666666-6666-4666-8666-666666666666",
        "recipientUserUuid": "77777777-7777-4777-8777-777777777777",
        "recipientDeviceUuid": "88888888-8888-4888-8888-888888888888",
        "recipientAgreementPublicKeyId": "99999999-9999-4999-8999-999999999999",
    }
    aad = (
        "flora.messaging.recipient-key-envelope.v1 | "
        f"{uu['conversationUuid']} | {uu['keyEpochId']} | {uu['messageUuid']} | {uu['messageKeyId']} | "
        f"{uu['senderUserUuid']} | {uu['senderDeviceUuid']} | {uu['recipientUserUuid']} | "
        f"{uu['recipientDeviceUuid']} | {uu['recipientAgreementPublicKeyId']}"
    )
    aad_bytes = aad.encode("utf-8")

    salt = hashlib.sha256(b"fscp_rke_wrap_key_v1|salt").digest()
    hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=aad_bytes)
    wrap_key = hkdf.derive(ss)

    message_key = hashlib.sha256(b"fscp_rke_wrap_key_v1|messageKey").digest()
    nonce = hashlib.sha256(b"fscp_rke_wrap_key_v1|nonce").digest()[:24]
    ct = nacl_bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
        message_key, aad_bytes, nonce, wrap_key
    )

    out = {
        "vectorId": "fscp_rke_wrap_key_v1_success",
        "fscpProtocolVersion": 1,
        "messageEnvelopeVersion": 1,
        "algorithm": "x25519-hkdf-xchacha20poly1305",
        "uuids": uu,
        "aadUtf8": aad,
        "aliceEphemeralPrivateKeyBase64Url": b64u(seed_a),
        "aliceEphemeralPublicKeyBase64Url": b64u(alice_eph.public_key().public_bytes_raw()),
        "bobAgreementPrivateKeyBase64Url": b64u(seed_b),
        "bobAgreementPublicKeyBase64Url": b64u(bob_ag.public_key().public_bytes_raw()),
        "x25519SharedSecretBase64Url": b64u(ss),
        "hkdfSaltBase64Url": b64u(salt),
        "hkdfInfoIsAad": True,
        "wrapKeyBase64Url": b64u(wrap_key),
        "messageKeyBase64Url": b64u(message_key),
        "aead": {
            "name": "xchacha20-poly1305",
            "nonceBase64Url": b64u(nonce),
            "ciphertextBase64Url": b64u(ct),
        },
    }
    path = Path(__file__).with_name("fscp-rke-wrap-key-v1.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print("wrote", path)


if __name__ == "__main__":
    main()
