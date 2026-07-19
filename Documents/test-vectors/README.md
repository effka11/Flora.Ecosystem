# Test vectors (FSCP / E2E)

Машиночитаемые golden-векторы для **FSCP v1.0** — см. [fscp/FSCP.md](../fscp/FSCP.md) §Test vectors. Платформенные векторы (backup, unlock, device) — [e2e-security.md](../fscp/e2e-security.md).

Кросс-языковые векторы паритета бэкенда C# ⇄ Rust (UUID, JWT, Argon2id) — [backend-parity/](backend-parity/README.md).

Векторы FIRA (скореры четырёх компонентов + постобработка FIRA-F; [FIRA.md](../fira/FIRA.md) §15) — `fira/`: `fira-f-scorer-v1.json`, `fira-f-postprocessing-v1.json`, `fira-c-scorer-v1.json`, `fira-p-scorer-v1.json`, `fira-m-scorer-v1.json`. Эталон — C# (`Tests/Flora.GoldenVectors/FiraGoldenVectorGenerator.cs`, регенерация `./Scripts/generate-golden-vectors.ps1`); consumer-тесты: C# `Tests/Flora.GoldenVectors/GoldenVectorTests.cs` (freeze-контроль), Rust `Backend/Tests/parity/tests/fira_vectors.rs`.

Векторы governance (профиль P0 криптоядра `flora-governance-crypto`; состав нормирован в [fgp/FGP-CRYPTO.md](../fgp/FGP-CRYPTO.md) §12) — `governance/`: ds-tags (реестр доменных меток байт-в-байт + civic-пайплайн), fx-q32 (детерминированная арифметика), log-merkle (+ негативы), fgp-weights; регенерация: `cargo run -p flora-governance-crypto --example gen_vectors`. Векторы personhood ([fpp/FPP.md](../fpp/FPP.md) §10.4) — `personhood/`: `personhood-naturalness-v1.json` — метрики натуральности NS ([fpp/FPP-SIGNALS.md](../fpp/FPP-SIGNALS.md) §7: burstiness, суточный профиль, CUSUM, калибровочные кривые, девайс-классы, свод/гистерезис, эпохальный тег устройства, реестр enum-флагов церемоний); регенерация: `cargo run -p fpp-core --example gen_personhood_vectors`; серверный consumer-тест — `Products/FPP/crates/fpp-core/tests/naturalness_vectors.rs`, клиентский (TS) появится с personhood-поверхностью client-core. С профилями P1/P2 добавятся деривации nullifier'ов, VRF/самовыборка, токены, транскрипт тэлли, membership/range. Правила ниже (base64url, `protocolVersion`, негативы, обязательные consumer-тесты) распространяются и на них.

## Файлы (v1.0)

| Файл | Vector id | Назначение |
| --- | --- | --- |
| [fscp-rke-wrap-key-v1.json](fscp-rke-wrap-key-v1.json) | `fscp_rke_wrap_key_v1_success` | X25519 + HKDF (RFC 5869, SHA-256, info=AAD) + XChaCha20-Poly1305 **IETF** (libsodium) для unwrap 32-байтового `messageKey` |
| [fingerprint-v1.json](fingerprint-v1.json) | `fingerprint_v1_success` | Safety number 1:1: SHA-256 от UTF-8 preimage (см. [fscp/FSCP.md](../fscp/FSCP.md) §Safety number) |
| [fscp-wire-validator-v1.json](fscp-wire-validator-v1.json) | `fscp_wire_validator_v1` | Серверная структурная валидация FSCP wire: позитив + негативы с точными строками ошибок (эталон `FscpWireEnvelopeValidator.cs`; форма заморожена — next-architecture.md §4.4) |
| [fscp-message-transcript-v1.json](fscp-message-transcript-v1.json) | `fscp_message_transcript_v1` | **Полный транскрипт** сообщения: plaintext (unicode) → body AEAD → RKE → canonical JSON → Ed25519 → `fscp1:`-wire со всеми промежуточными значениями + варианты `signature_tampered` / `legacy_unsigned` |
| [franking-v1.json](franking-v1.json) | `fscp_franking_v1` | Message franking ([fscp/franking.md](../fscp/franking.md)): commit → HMAC-тег → квитанция → verify жюри + негативы; франкуется сообщение транскрипт-вектора |
| [fscp-hybrid-kem-v2draft-v1.json](fscp-hybrid-kem-v2draft-v1.json) | `fscp_hybrid_kem_v2draft_v1` | **v2-draft, вне нормы v1**: гибридный пост-квантовый KEM X25519+ML-KEM-768 ([fscp/FSCP.md](../fscp/FSCP.md) §Целевой алгоритм → Post-quantum) — детерминированные FIPS 203 keygen/encaps/decaps, transcript-hash, гибридный HKDF, AEAD, негативы (implicit rejection, AAD mismatch) |

Consumer-тесты (обязательны, см. правила ниже): `Packages/flora-client-core/src/fscp/goldenVectors.test.ts`, `transcriptVector.test.ts`, `frankingVector.test.ts` и `hybridKemVector.test.ts` (клиент TS, включая полный decrypt через публичное API, franking-эталон и ML-KEM через @noble/post-quantum), `Packages/flora-client-core/src/fscp/webParity.test.ts` (parity Web ↔ client-core), `Tests/Flora.GoldenVectors/FscpWireValidatorVectors.cs` (сервер C#, включая транскрипт-wire), `Backend/Tests/parity/tests/fscp_wire_vectors.rs` (сервер Rust, порт `flora-messaging/src/fscp.rs`), `Backend/Tests/parity/tests/fscp_client_crypto_vectors.rs`, `fscp_transcript_vectors.rs`, `fscp_franking_vectors.rs` и `fscp_hybrid_kem_vectors.rs` (клиентская криптография на RustCrypto + ed25519-dalek + ml-kem + canonical JSON `Backend/Tests/parity/src/canonical_json.rs`).

## Регенерация

`fscp-rke-wrap-key-v1.json`, `fscp-message-transcript-v1.json`, `franking-v1.json` и `fscp-hybrid-kem-v2draft-v1.json` — из каталога `Documents/test-vectors/` (нужны `cryptography`, `PyNaCl`; для гибридного KEM — ещё `kyber-py`; franking читает транскрипт — порядок важен):

```bash
python _gen_fscp_rke_v1.py
python _gen_fscp_message_transcript_v1.py
python _gen_fscp_franking_v1.py
python _gen_fscp_hybrid_kem_v2draft_v1.py
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
