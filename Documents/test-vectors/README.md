# Test vectors (FSCP / E2E)

Машиночитаемые golden-векторы для **FSCP v1.0** и аддитивной дельты **v1.1 (franking)** — см. [fscp/FSCP.md](../fscp/FSCP.md) §Test vectors. Платформенные векторы (backup, unlock, device) — [e2e-security.md](../fscp/e2e-security.md).

Кросс-языковые векторы паритета бэкенда (UUID, JWT, Argon2id) — [backend-parity/](backend-parity/README.md): исторический эталон C# (Фаза 5 снята), файлы **заморожены**; живые consumers — Rust `Backend/Tests/parity` (+ TS `deriveIds` для uuid).

Векторы FIRA (скореры четырёх компонентов + постобработка FIRA-F; [FIRA.md](../fira/FIRA.md) §15) — `fira/`: `fira-f-scorer-v1.json`, `fira-f-postprocessing-v1.json`, `fira-c-scorer-v1.json`, `fira-p-scorer-v1.json`, `fira-m-scorer-v1.json`. Исторический эталон — C# (снят с Фазой 5); файлы **заморожены**, `Scripts/generate-golden-vectors.ps1` регенерацию не выполняет. Живой consumer — Rust `Backend/Tests/parity/tests/fira_vectors.rs`.

Векторы governance (профиль P0 криптоядра `flora-governance-crypto`; состав нормирован в [fgp/FGP-CRYPTO.md](../fgp/FGP-CRYPTO.md) §12) — `governance/`: ds-tags (реестр доменных меток байт-в-байт + civic-пайплайн), fx-q32 (детерминированная арифметика), log-merkle (+ негативы), log-sth (STH и витнесс-косайны, клиентское правило «≥ 3»; + негативы), sortition (сид окна из `(STH, внешний якорь)` и детерминированная жеребьёвка), commit-reveal (+ негативы), fgp-weights (формулы FGP §4/§5.6: затухание, вес голоса, делегация, conviction, sample size, trimmed mean панелей, корреляционный дисконт), bridging (детерминированная матричная факторизация L3, FGP §6.2); регенерация: `cargo run -p flora-governance-crypto --example gen_vectors`; consumer-тест — `Products/FGP/crates/flora-governance-crypto/tests/governance_vectors.rs`. Векторы personhood ([fpp/FPP.md](../fpp/FPP.md) §10.4) — `personhood/`: `personhood-naturalness-v1.json` — метрики натуральности NS ([fpp/FPP-SIGNALS.md](../fpp/FPP-SIGNALS.md) §7: wire-реестры `registries`, burstiness, суточный профиль, CUSUM, калибровочные кривые, девайс-классы, свод/гистерезис, bucket-профиль и отчёт следственной панели §4.1 — квантование, веса девайс-наблюдений, согласованность A↔C, сценарии `assemble`, — каноническая эпоха и эпохальный тег устройства `epoch`, клиентский путь отчёта эпохи `epochReport`) + негативный `personhood-naturalness-negative-v1.json` (отказы формы отчёта эпохи §3.1, неизвестные wire-коды, невалидные кривые); регенерация: `cargo run -p fpp-core --example gen_personhood_vectors`; consumer-тесты — Rust `Products/FPP/crates/fpp-core/tests/naturalness_vectors.rs`, TS `Packages/flora-client-core/src/personhood/personhoodVectors.test.ts`. С профилями P1/P2 добавятся деривации nullifier'ов, VRF/самовыборка, токены, транскрипт тэлли, membership/range. Правила ниже (base64url, `protocolVersion`, негативы, обязательные consumer-тесты) распространяются и на них.

Векторы FEP/LIV (ядро `flora-economy-crypto`; нормированы в [fep/FEP.md](../fep/FEP.md) §9, [fep/LIV.md](../fep/LIV.md) Приложение) — `fep/`: `fep-domain-tags-v1.json` (реестр меток + SHA-256 tagged), `fep-liv-amounts-v1.json` (канонический формат сумм LIV), `fep-ledger-transcript-v1.json` (полный транскрипт журнала: все виды записей, head'ы, inclusion/consistency-доказательства, витнесс-косайны, финальное состояние), `fep-ledger-negative-v1.json` (обязательные отказы реплея/consistency/косайнов). Байтовые поля — **hex lowercase** (родная кодировка контракта FEP: JSONL-журнал и HTTP API; поле `encoding: "hex"` в каждом файле). Регенерация: `cargo run -p flora-economy-crypto --example gen_vectors`; consumer-тесты — Rust `Products/FEP/crates/flora-economy-crypto/tests/fep_vectors.rs`, TS `Packages/flora-client-core/src/economy/fepVectors.test.ts` (чистый TS-слой) и `wasm.test.ts` (wasm-ядро `flora-economy-wasm`, включая negative-реплей).

## Файлы (v1.0)

| Файл | Vector id | Назначение |
| --- | --- | --- |
| [fscp-rke-wrap-key-v1.json](fscp-rke-wrap-key-v1.json) | `fscp_rke_wrap_key_v1_success` | X25519 + HKDF (RFC 5869, SHA-256, info=AAD) + XChaCha20-Poly1305 **IETF** (libsodium) для unwrap 32-байтового `messageKey` |
| [fingerprint-v1.json](fingerprint-v1.json) | `fingerprint_v1_success` | Safety number 1:1: SHA-256 от UTF-8 preimage (см. [fscp/FSCP.md](../fscp/FSCP.md) §Safety number) |
| [fscp-wire-validator-v1.json](fscp-wire-validator-v1.json) | `fscp_wire_validator_v1` | Серверная структурная валидация FSCP wire: позитив + негативы с точными строками ошибок (исторический эталон C# `FscpWireEnvelopeValidator`; форма заморожена — next-architecture.md §4.4; consumer — Rust `fscp_wire_vectors.rs`) |
| [fscp-message-transcript-v1.json](fscp-message-transcript-v1.json) | `fscp_message_transcript_v1` | **Полный транскрипт** сообщения: plaintext (unicode) → body AEAD → RKE → canonical JSON → Ed25519 → `fscp1:`-wire со всеми промежуточными значениями + варианты `signature_tampered` / `legacy_unsigned` |
| [franking-v1.json](franking-v1.json) | `fscp_franking_v1` | Message franking ([fscp/franking.md](../fscp/franking.md)): commit → HMAC-тег → квитанция → verify жюри + негативы; франкуется сообщение транскрипт-вектора |

## Файлы (v1.1 franking)

| Файл | Vector id | Назначение |
| --- | --- | --- |
| [fscp-franking-wire-v1_1.json](fscp-franking-wire-v1_1.json) | `fscp_franking_wire_v1_1` | Wire-дельта v1.1: Algorithm A (commit/HMAC/AAD `message.v1_1`) + recorded tagged `fscp1:` (roundtrip, подмена тега); регенерация `npm run generate:franking-wire-v1-1-vector --workspace=@flora/fscp` |
| [fscp-franking-disclosure-bundle-v2.json](fscp-franking-disclosure-bundle-v2.json) | `fscp_franking_disclosure_bundle_v2` | Канонические байты кортежа раскрытия v1 + bundle/wrap v2; регенерация `npm run generate:franking-disclosure-bundle-v2-vector --workspace=@flora/fscp` |

## Файлы (v2-draft)

| Файл | Vector id | Назначение |
| --- | --- | --- |
| [fscp-hybrid-kem-v2draft-v1.json](fscp-hybrid-kem-v2draft-v1.json) | `fscp_hybrid_kem_v2draft_v1` | Вне нормы v1: гибридный пост-квантовый KEM X25519+ML-KEM-768 ([fscp/FSCP.md](../fscp/FSCP.md) §Целевой алгоритм → Post-quantum) — детерминированные FIPS 203 keygen/encaps/decaps, transcript-hash, гибридный HKDF, AEAD, негативы (implicit rejection, AAD mismatch) |

Consumer-тесты (обязательны, см. правила ниже): TS `@flora/fscp` — [`Products/FSCP/ts/src/goldenVectors.test.ts`](../../Products/FSCP/ts/src/goldenVectors.test.ts), `transcriptVector.test.ts`, `frankingVector.test.ts`, `hybridKemVector.test.ts`, `webParity.test.ts`, `frankingWireVectorV1_1.test.ts`, `frankingDisclosureBundleVector.test.ts`; Rust — `Backend/Tests/parity/tests/fscp_wire_vectors.rs`, `fscp_client_crypto_vectors.rs`, `fscp_transcript_vectors.rs`, `fscp_franking_vectors.rs`, `fscp_franking_wire_v1_1.rs`, `fscp_hybrid_kem_vectors.rs` (RustCrypto + ed25519-dalek + ml-kem + canonical JSON `Backend/Tests/parity/src/canonical_json.rs`). C#-consumer `Tests/Flora.GoldenVectors/*` снят с Фазой 5; текущий CI — `npm run test` / `cargo test`.

## Регенерация

`fscp-rke-wrap-key-v1.json`, `fscp-message-transcript-v1.json` и `franking-v1.json` — из каталога `Documents/test-vectors/` (нужны `cryptography`, `PyNaCl`; franking читает транскрипт — порядок важен):

```bash
python _gen_fscp_rke_v1.py
python _gen_fscp_message_transcript_v1.py
python _gen_fscp_franking_v1.py
```

`fscp-hybrid-kem-v2draft-v1.json` — тот же каталог, дополнительно `kyber-py`:

```bash
python _gen_fscp_hybrid_kem_v2draft_v1.py
```

`fscp-wire-validator-v1.json` и `backend-parity/*` — **заморожены** (исторически из C#-эталона; `Scripts/generate-golden-vectors.ps1` снят с Фазой 5 и сразу выходит с ошибкой).

`fscp-franking-wire-v1_1.json` и `fscp-franking-disclosure-bundle-v2.json` — из `@flora/fscp` (детерминированные генераторы; повторный запуск обязан дать идентичный JSON):

```bash
npm run generate:franking-wire-v1-1-vector --workspace=@flora/fscp
npm run generate:franking-disclosure-bundle-v2-vector --workspace=@flora/fscp
```

Генераторы детерминированы: повторный запуск перезаписывает JSON **идентичным** содержимым при неизменных алгоритмах.

## Правила для будущих векторов

- поле `protocolVersion` / `fscpProtocolVersion` в каждом файле;
- base64url **без padding**;
- для строк AAD — **байт-в-байт** совпадение с нормативным текстом в [fscp/FSCP.md](../fscp/FSCP.md);
- негативные векторы — отдельные файлы с полем `expectedError`;
- каждый вектор **обязан** иметь consumer-тест (клиент + сервер), иначе compliance-пункт не выполнен — см. [fscp/FSCP.md](../fscp/FSCP.md) §Test vectors «требование потребления». Файлы здесь — regenerate-only (не редактировать руками).

Ссылки: [fscp/FSCP.md](../fscp/FSCP.md), [e2e-security.md](../fscp/e2e-security.md).
