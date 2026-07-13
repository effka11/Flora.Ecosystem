# Test vectors (FSCP / E2E)

Машиночитаемые golden-векторы для **FSCP v1.0** — см. [fscp/FSCP.md](../fscp/FSCP.md) §Test vectors. Платформенные векторы (backup, unlock, device) — [e2e-security.md](../fscp/e2e-security.md).

Кросс-языковые векторы паритета бэкенда C# ⇄ Rust (UUID, JWT, Argon2id) — [backend-parity/](backend-parity/README.md).

## Файлы (v1.0)

| Файл | Vector id | Назначение |
| --- | --- | --- |
| [fscp-rke-wrap-key-v1.json](fscp-rke-wrap-key-v1.json) | `fscp_rke_wrap_key_v1_success` | X25519 + HKDF (RFC 5869, SHA-256, info=AAD) + XChaCha20-Poly1305 **IETF** (libsodium) для unwrap 32-байтового `messageKey` |
| [fingerprint-v1.json](fingerprint-v1.json) | `fingerprint_v1_success` | Safety number 1:1: SHA-256 от UTF-8 preimage (см. [fscp/FSCP.md](../fscp/FSCP.md) §Safety number) |
| [fscp-wire-validator-v1.json](fscp-wire-validator-v1.json) | `fscp_wire_validator_v1` | Серверная структурная валидация FSCP wire: позитив + негативы с точными строками ошибок (эталон `FscpWireEnvelopeValidator.cs`; форма заморожена — next-architecture.md §4.4) |

Consumer-тесты (обязательны, см. правила ниже): `Packages/flora-client-core/src/fscp/goldenVectors.test.ts` (клиент TS), `Packages/flora-client-core/src/fscp/webParity.test.ts` (parity Web ↔ client-core), `tests/Flora.GoldenVectors/FscpWireValidatorVectors.cs` (сервер C#), `Backend/tests/parity/tests/fscp_wire_vectors.rs` (сервер Rust, порт `flora-messaging/src/fscp.rs`), `Backend/tests/parity/tests/fscp_client_crypto_vectors.rs` (клиентская криптография на RustCrypto).

## Регенерация

`fscp-rke-wrap-key-v1.json` — из каталога `docs/test-vectors/` (нужны `cryptography`, `PyNaCl`):

```bash
python _gen_fscp_rke_v1.py
```

`fscp-wire-validator-v1.json` и `backend-parity/*` — из C#-эталона:

```powershell
./Scripts/generate-golden-vectors.ps1
```

Генераторы детерминированы: повторный запуск перезаписывает JSON **идентичным** содержимым при неизменных алгоритмах.

## Правила для будущих векторов

- поле `protocolVersion` / `fscpProtocolVersion` в каждом файле;
- base64url **без padding**;
- для строк AAD — **байт-в-байт** совпадение с нормативным текстом в [fscp/FSCP.md](../fscp/FSCP.md);
- негативные векторы — отдельные файлы с полем `expectedError`;
- каждый вектор **обязан** иметь consumer-тест (клиент + сервер), иначе compliance-пункт не выполнен — см. [fscp/FSCP.md](../fscp/FSCP.md) §Test vectors «требование потребления». Файлы здесь — regenerate-only (не редактировать руками).

Ссылки: [fscp/FSCP.md](../fscp/FSCP.md), [e2e-security.md](../fscp/e2e-security.md).
