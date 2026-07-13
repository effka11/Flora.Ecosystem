"""One-off generator for franking-v1.json — run: python _gen_fscp_franking_v1.py

Message franking v1 (docs/fscp/franking.md): commitInput -> HMAC-SHA-256 frankTag ->
receiptPayload -> Ed25519-квитанция сервера -> полный verify-путь жюри + негативы.
Франкуется РОВНО то сообщение, что в fscp-message-transcript-v1.json (запустить его
генератор первым) — связка векторов: жалоба доказуема для реального транскрипта.
Детерминирован: ключи/время — фиксированные метки.
Consumers: TS frankingVector.test.ts, Rust fscp_franking_vectors.rs.
"""
import base64
import hashlib
import hmac as hmac_mod
import json
from pathlib import Path

from nacl.signing import SigningKey

LABEL = b"fscp_franking_v1"
COMMIT_CONTEXT = "flora.fscp.franking.v1"
RECEIPT_CONTEXT = "flora.fscp.franking-receipt.v1"
SERVER_RECEIVED_AT = "2026-01-01T00:00:01.000Z"
SERVER_FRANKING_KEY_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def seed(label: str) -> bytes:
    return hashlib.sha256(LABEL + b"|" + label.encode()).digest()


def commit_input(uu: dict, created_at: str, plaintext_utf8: bytes) -> str:
    return " | ".join([
        COMMIT_CONTEXT,
        uu["conversationUuid"].lower(),
        uu["messageUuid"].lower(),
        uu["senderUserUuid"].lower(),
        uu["senderDeviceUuid"].lower(),
        uu["receiverUserUuid"].lower(),
        created_at,
        b64u(hashlib.sha256(plaintext_utf8).digest()),
    ])


def receipt_payload(frank_tag_b64u: str, uu: dict, server_received_at: str) -> str:
    return " | ".join([
        RECEIPT_CONTEXT,
        frank_tag_b64u,
        uu["messageUuid"].lower(),
        uu["conversationUuid"].lower(),
        uu["senderUserUuid"].lower(),
        uu["receiverUserUuid"].lower(),
        server_received_at,
    ])


def main() -> None:
    here = Path(__file__).parent
    transcript = json.loads((here / "fscp-message-transcript-v1.json").read_text(encoding="utf-8"))
    uu = transcript["uuids"]
    created_at = transcript["createdAt"]
    plaintext_utf8 = transcript["plaintextUtf8"].encode("utf-8")

    franking_key = seed("franking_key")
    ci = commit_input(uu, created_at, plaintext_utf8)
    frank_tag = hmac_mod.new(franking_key, ci.encode("utf-8"), hashlib.sha256).digest()

    server_seed = seed("server_franking_seed")
    server_key = SigningKey(server_seed)
    server_pub = bytes(server_key.verify_key)
    rp = receipt_payload(b64u(frank_tag), uu, SERVER_RECEIVED_AT)
    receipt_sig = server_key.sign(rp.encode("utf-8")).signature

    # --- негативы (все поля остальные — из позитивного кортежа) ---
    tampered_sig = bytearray(receipt_sig)
    tampered_sig[0] ^= 0x01

    negatives = [
        {
            "caseId": "plaintext_tampered",
            "description": "Жалобщик подменил plaintext: HMAC не сойдётся (binding commitment).",
            "plaintextUtf8": transcript["plaintextUtf8"].replace("Привет", "Пока"),
            "expectedFailure": "commit-mismatch",
        },
        {
            "caseId": "franking_key_wrong",
            "description": "Другой frankingKey: не существует (K', m') с тем же тегом.",
            "frankingKeyBase64Url": b64u(seed("wrong_franking_key")),
            "expectedFailure": "commit-mismatch",
        },
        {
            "caseId": "receipt_signature_tampered",
            "description": "Бит подписи квитанции инвертирован.",
            "receiptSignatureBase64Url": b64u(bytes(tampered_sig)),
            "expectedFailure": "receipt-signature-invalid",
        },
        {
            "caseId": "message_uuid_mismatch",
            "description": "Жалоба про другой messageUuid: metadata-binding срабатывает уже на шаге HMAC (uuid входит в commitInput).",
            "messageUuid": transcript["uuids"]["messageKeyId"],
            "expectedFailure": "commit-mismatch",
        },
        {
            "caseId": "receipt_time_mismatch",
            "description": "Подмена serverReceivedAt (есть только в receiptPayload): HMAC сходится, подпись сервера — нет.",
            "serverReceivedAt": "2026-01-01T00:00:02.000Z",
            "expectedFailure": "receipt-signature-invalid",
        },
    ]

    out = {
        "vectorId": "fscp_franking_v1",
        "fscpProtocolVersion": 1,
        "frankingVersion": 1,
        "description": (
            "Message franking v1 (FSCP-FRANK, docs/fscp/franking.md): commit -> tag -> receipt -> "
            "полная верификация жюри. Франкуется сообщение из fscp-message-transcript-v1.json "
            "(регенерировать транскрипт первым). Wire-активация franking — v1.1+; вектор закрепляет "
            "примитивы заранее."
        ),
        "commitContext": COMMIT_CONTEXT,
        "receiptContext": RECEIPT_CONTEXT,
        "uuids": {
            "conversationUuid": uu["conversationUuid"],
            "messageUuid": uu["messageUuid"],
            "senderUserUuid": uu["senderUserUuid"],
            "senderDeviceUuid": uu["senderDeviceUuid"],
            "receiverUserUuid": uu["receiverUserUuid"],
        },
        "createdAt": created_at,
        "plaintextUtf8": transcript["plaintextUtf8"],
        "plaintextSha256Base64Url": b64u(hashlib.sha256(plaintext_utf8).digest()),
        "frankingKeyBase64Url": b64u(franking_key),
        "commitInputUtf8": ci,
        "frankTagBase64Url": b64u(frank_tag),
        "server": {
            "frankingSigningSeedBase64Url": b64u(server_seed),
            "frankingPublicKeyBase64Url": b64u(server_pub),
        },
        "receiptPayloadUtf8": rp,
        "receipt": {
            "signatureBase64Url": b64u(receipt_sig),
            "serverFrankingKeyId": SERVER_FRANKING_KEY_ID,
            "serverReceivedAt": SERVER_RECEIVED_AT,
        },
        "negatives": negatives,
    }

    path = here / "franking-v1.json"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", path)


if __name__ == "__main__":
    main()
