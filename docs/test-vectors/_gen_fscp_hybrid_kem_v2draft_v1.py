"""One-off generator for fscp-hybrid-kem-v2draft-v1.json — run: python _gen_fscp_hybrid_kem_v2draft_v1.py

FSCP v2-draft: гибридный KEM X25519 + ML-KEM-768 (FIPS 203) для RKE.
Прототип по FSCP.md §Целевой алгоритм → Post-quantum. Wire v1 НЕ затрагивает.

Три независимые реализации ML-KEM: kyber-py (этот генератор),
@noble/post-quantum (TS-consumer), RustCrypto ml-kem (Rust-consumer).

Конструкция комбинера (X-Wing/PQXDH-дисциплина):
  ss_x25519  = X25519(eph_priv, recipient_agreement_pub)
  (ss_mlkem, ct_mlkem) = ML-KEM-768.Encaps(recipient_ek; m)
  transcriptHash = SHA-256("flora.fscp.v2draft.hybrid-transcript" utf8
                           || eph_pub(32) || recipient_agreement_pub(32)
                           || recipient_ek(1184) || ct_mlkem(1088))
  aadLine  = "flora.messaging.recipient-key-envelope.v2draft | <10 uuid> | pq:" + b64u(transcriptHash)
  IKM      = ss_x25519 || ss_mlkem            (классическая компонента первая)
  PRK      = HKDF-Extract(SHA-256, salt32, IKM)
  wrapKey  = HKDF-Expand(SHA-256, PRK, info=aadLine utf8, 32)
  RKE ct   = XChaCha20-Poly1305(wrapKey, nonce24, messageKey32, aad=aadLine utf8)
"""
import base64
import hashlib
import json
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from kyber_py.ml_kem import ML_KEM_768
from nacl import bindings as nacl_bindings

DOMAIN = "fscp_hybrid_kem_v2draft_v1"
TRANSCRIPT_PREFIX = b"flora.fscp.v2draft.hybrid-transcript"
AAD_PREFIX = "flora.messaging.recipient-key-envelope.v2draft"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def seed(label: str) -> bytes:
    return hashlib.sha256(f"{DOMAIN}|{label}".encode()).digest()


def transcript_hash(eph_pub: bytes, agr_pub: bytes, ek: bytes, ct: bytes) -> bytes:
    assert (len(eph_pub), len(agr_pub), len(ek), len(ct)) == (32, 32, 1184, 1088)
    return hashlib.sha256(TRANSCRIPT_PREFIX + eph_pub + agr_pub + ek + ct).digest()


def aad_line(uu: dict, th: bytes) -> str:
    return (
        f"{AAD_PREFIX} | "
        f"{uu['conversationUuid']} | {uu['keyEpochId']} | {uu['messageUuid']} | {uu['messageKeyId']} | "
        f"{uu['senderUserUuid']} | {uu['senderDeviceUuid']} | {uu['recipientUserUuid']} | "
        f"{uu['recipientDeviceUuid']} | {uu['recipientAgreementPublicKeyId']} | "
        f"{uu['recipientMlKemEncapsulationKeyId']} | pq:{b64u(th)}"
    )


def derive_wrap_key(salt: bytes, ss_x: bytes, ss_pq: bytes, aad_utf8: bytes) -> bytes:
    hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=aad_utf8)
    return hkdf.derive(ss_x + ss_pq)


def main() -> None:
    # --- ключи получателя: классический X25519 agreement + ML-KEM-768 ek ---
    bob_x_seed = seed("bob_agreement")
    bob_x = x25519.X25519PrivateKey.from_private_bytes(bob_x_seed)
    bob_x_pub = bob_x.public_key().public_bytes_raw()

    d, z = seed("mlkem_d"), seed("mlkem_z")
    ek, dk = ML_KEM_768._keygen_internal(d, z)

    # --- отправитель: эфемерный X25519 + детерминированный encaps ---
    alice_seed = seed("alice_ephemeral")
    alice = x25519.X25519PrivateKey.from_private_bytes(alice_seed)
    alice_pub = alice.public_key().public_bytes_raw()
    ss_x = alice.exchange(bob_x.public_key())

    m = seed("mlkem_m")
    ss_pq, ct_pq = ML_KEM_768._encaps_internal(ek, m)

    uu = {
        "conversationUuid": "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1",
        "keyEpochId": "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2",
        "messageUuid": "c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3",
        "messageKeyId": "d4d4d4d4-4444-4444-8444-d4d4d4d4d4d4",
        "senderUserUuid": "e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5",
        "senderDeviceUuid": "f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6",
        "recipientUserUuid": "a7a7a7a7-7777-4777-8777-a7a7a7a7a7a7",
        "recipientDeviceUuid": "b8b8b8b8-8888-4888-8888-b8b8b8b8b8b8",
        "recipientAgreementPublicKeyId": "c9c9c9c9-9999-4999-8999-c9c9c9c9c9c9",
        "recipientMlKemEncapsulationKeyId": "d0d0d0d0-0000-4000-8000-d0d0d0d0d0d0",
    }

    th = transcript_hash(alice_pub, bob_x_pub, ek, ct_pq)
    aad = aad_line(uu, th)
    aad_bytes = aad.encode("utf-8")

    salt = seed("salt")
    wrap_key = derive_wrap_key(salt, ss_x, ss_pq, aad_bytes)

    message_key = seed("messageKey")
    nonce = seed("nonce")[:24]
    rke_ct = nacl_bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
        message_key, aad_bytes, nonce, wrap_key
    )

    # --- негатив 1: подмена ML-KEM ciphertext (implicit rejection FIPS 203) ---
    tampered_ct = bytearray(ct_pq)
    tampered_ct[-1] ^= 0x01
    tampered_ct = bytes(tampered_ct)
    implied_ss = ML_KEM_768.decaps(dk, tampered_ct)  # K̄ = J(z || c), детерминирован
    tampered_th = transcript_hash(alice_pub, bob_x_pub, ek, tampered_ct)
    tampered_aad = aad_line(uu, tampered_th)

    # --- негатив 2: расхождение метаданных (чужой recipientDeviceUuid) ---
    uu_mismatch = dict(uu)
    uu_mismatch["recipientDeviceUuid"] = "b8b8b8b8-8888-4888-8888-000000000000"
    mismatched_aad = aad_line(uu_mismatch, th)

    out = {
        "vectorId": "fscp_hybrid_kem_v2draft_v1_success",
        "fscpProtocolVersion": "2-draft",
        "status": "prototype: FSCP.md §Целевой алгоритм → Post-quantum; в норму v1 не входит, wire v1 не меняет",
        "algorithm": "x25519+ml-kem-768 | hkdf-sha256 | xchacha20-poly1305",
        "combiner": {
            "ikmOrder": "ss_x25519 || ss_mlkem",
            "transcriptHash": "SHA-256(utf8(prefix) || ephPub32 || agreementPub32 || ek1184 || ct1088)",
            "transcriptPrefixUtf8": TRANSCRIPT_PREFIX.decode(),
            "hkdfInfoIsAad": True,
            "aadPrefixUtf8": AAD_PREFIX,
        },
        "uuids": uu,
        "x25519": {
            "aliceEphemeralPrivateKeyBase64Url": b64u(alice_seed),
            "aliceEphemeralPublicKeyBase64Url": b64u(alice_pub),
            "bobAgreementPrivateKeyBase64Url": b64u(bob_x_seed),
            "bobAgreementPublicKeyBase64Url": b64u(bob_x_pub),
            "sharedSecretBase64Url": b64u(ss_x),
        },
        "mlKem768": {
            "dSeedBase64Url": b64u(d),
            "zSeedBase64Url": b64u(z),
            "keygenSeedBase64Url": b64u(d + z),
            "encapsulationKeyBase64Url": b64u(ek),
            "decapsulationKeyExpandedBase64Url": b64u(dk),
            "encapsMSeedBase64Url": b64u(m),
            "ciphertextBase64Url": b64u(ct_pq),
            "sharedSecretBase64Url": b64u(ss_pq),
        },
        "hybrid": {
            "transcriptHashBase64Url": b64u(th),
            "aadUtf8": aad,
            "hkdfSaltBase64Url": b64u(salt),
            "ikmBase64Url": b64u(ss_x + ss_pq),
            "wrapKeyBase64Url": b64u(wrap_key),
        },
        "aead": {
            "name": "xchacha20-poly1305",
            "messageKeyBase64Url": b64u(message_key),
            "nonceBase64Url": b64u(nonce),
            "ciphertextBase64Url": b64u(rke_ct),
        },
        "negativeCases": [
            {
                "caseId": "mlkem_ciphertext_tampered",
                "description": "последний байт ct_mlkem инвертирован: FIPS 203 implicit rejection даёт K̄=J(z||c); транскрипт-хэш и AAD получателя расходятся с отправителем — AEAD не открывается",
                "tamperedCiphertextBase64Url": b64u(tampered_ct),
                "impliedSharedSecretBase64Url": b64u(implied_ss),
                "tamperedTranscriptHashBase64Url": b64u(tampered_th),
                "tamperedAadUtf8": tampered_aad,
                "expected": "aead-open-fails",
            },
            {
                "caseId": "aad_metadata_mismatch",
                "description": "получатель подставляет чужой recipientDeviceUuid: HKDF-info и AAD меняются — AEAD не открывается",
                "mismatchedAadUtf8": mismatched_aad,
                "expected": "aead-open-fails",
            },
        ],
    }

    path = Path(__file__).with_name("fscp-hybrid-kem-v2draft-v1.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", path)


if __name__ == "__main__":
    main()
