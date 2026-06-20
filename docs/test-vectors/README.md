# Test vectors (FSCP / E2E)

Машиночитаемые golden-векторы для **FSCP v1.0** — см. [fscp/FSCP.md](../fscp/FSCP.md) §Test vectors. Платформенные векторы (backup, unlock, device) — [e2e-security.md](../fscp/e2e-security.md).

## Файлы (v1.0)

| Файл | Vector id | Назначение |
| --- | --- | --- |
| [fscp-rke-wrap-key-v1.json](fscp-rke-wrap-key-v1.json) | `fscp_rke_wrap_key_v1_success` | X25519 + HKDF (RFC 5869, SHA-256, info=AAD) + XChaCha20-Poly1305 **IETF** (libsodium) для unwrap 32-байтового `messageKey` |
| [fingerprint-v1.json](fingerprint-v1.json) | `fingerprint_v1_success` | Safety number 1:1: SHA-256 от UTF-8 preimage (см. [fscp/FSCP.md](../fscp/FSCP.md) §Safety number) |

## Регенерация `fscp-rke-wrap-key-v1.json`

Из каталога `docs/test-vectors/` (нужны `cryptography`, `PyNaCl`):

```bash
python _gen_fscp_rke_v1.py
```

Скрипт детерминирован: повторный запуск перезаписывает JSON **идентичным** содержимым при неизменных алгоритмах библиотек.

## Правила для будущих векторов

- поле `protocolVersion` / `fscpProtocolVersion` в каждом файле;
- base64url **без padding**;
- для строк AAD — **байт-в-байт** совпадение с нормативным текстом в [fscp/FSCP.md](../fscp/FSCP.md);
- негативные векторы — отдельные файлы с полем `expectedError`.

Ссылки: [fscp/FSCP.md](../fscp/FSCP.md), [e2e-security.md](../fscp/e2e-security.md).
