# FRC-I — поднятие версии битстрима (playbook)

**Status:** Operational  
**SoT формата:** [`FRC-I.md`](./FRC-I.md) §10  
**Продуктовый пайплайн:** [`CODECS-IMAGE.md`](./CODECS-IMAGE.md)

Этот документ — **как согласовать bump** wire-версии FRC-I со всеми артефактами репо.
Спецификация wire — только в `FRC-I.md`; здесь чеклист, чтобы не сломать Web/Mobile декод.

---

## Симптом рассинхрона

`FrcICodec.load` в `@flora/frc-i` сравнивает:

| Источник | Поле |
| --- | --- |
| WASM `frc_i_version()` | `(BITSTREAM_VERSION << 8) \| ABI` |
| TS `FRC_I_BITSTREAM_VERSION` / `FRC_I_WASM_ABI_VERSION` | ожидаемые значения |

При несовпадении load бросает `Несовместимый FRC-I WASM` → Worker не декодит →
в Apps/Web все `FrcImage` (лента, аватары, чат) показывают «Не удалось загрузить фото»,
хотя `GET /api/auth/posts/images/…` остаётся **200**. Это **не** миграции БД.

---

## Что должно совпадать после freeze `vN`

| # | Артефакт | Где | Правило |
| --- | --- | --- | --- |
| 1 | Wire / decoder max | `Products/FRC/crates/frc-i` → `format::VERSION_MAX`, `BITSTREAM_VERSION` | = `N` |
| 2 | Спека | `Documents/codecs/FRC-I.md` Status + §10 | Frozen `vN`, decoder `v1..vN` |
| 3 | Реестр | `Documents/codecs/CODECS.md` строка FRC-I | frozen `vN` |
| 4 | TS gate | `Products/FRC/ts/src/index.ts` → `FRC_I_BITSTREAM_VERSION` | = `N` |
| 5 | TS contract test | `Products/FRC/ts/test/contracts.test.ts` | `toBe(N)` |
| 6 | WASM ABI | `frc-i-wasm` `frc_i_version` младший байт ↔ `FRC_I_WASM_ABI_VERSION` | сейчас `2`; bump ABI отдельно от wire |
| 7 | WASM artifact | `Apps/Web/public/frc/frc_i_wasm.wasm` | **не в git** (`.gitignore`); всегда пересобирать из workspace (`Apps/Web` `predev`/`prebuild` → `build-frc-i-wasm.ts`) |
| 8 | Goldens | `Products/FRC/crates/frc-i/tests/data/golden-vN-*.fri` | по правилам §10 (см. ниже) |
| 9 | Package / ecosystem | `Products/FRC/package.json` (+ `description` wire), корневой / `Backend/flora-versions.json` | bump semver продукта `@flora/frc-i` при релизе (wire `N` ≠ `0.x.y-alpha`) |
| 10 | Contract fixtures | `Artifacts/contract-fixtures/api-version.json` | **не править руками** — только регенерация из эталона (`AGENTS.md`) |
| 11 | Mobile FFI + sniff | `frc-i-mobile-ffi` / Expo `flora-frc-i`; `Apps/Mobile/lib/frcImageCache.ts` → `FRC_VERSION_MAX` | тот же Rust `frc-i`; `FRC_VERSION_MAX = FRC_I_BITSTREAM_VERSION`; native rebuild обязателен |

MIME `image/x-flora-frc-i` **не** несёт номер wire (`acceptsFrcI` смотрит только тип до `;`).
Совместимость — magic + byte версии в файле + gate `FrcICodec.load`.

### Goldens (кратко из §10)

| Класс | Примеры | При bump `vN` |
| --- | --- | --- |
| Decode-freeze навсегда | `v1`, `v2`, `v6` | не трогать / не регенерировать |
| Legacy reference-encode | `v3`…`v5` | не «подгонять» под новый кодер; служебная regen только через `FRC_I_UPDATE_GOLDEN=1` |
| Immutable encode/decode freeze | `v7`…`v(N-1)` | не регенерировать; расхождение → новая версия, не правка файла |
| Текущий публичный кодер | `golden-vN-*.fri` | добавить/заморозить по §10 |

---

## Чеклист bump wire `v(N-1)` → `vN`

Делай **в одном PR** (или связке с явным DoD): TS gate и Rust `BITSTREAM_VERSION` меняются вместе.
Иначе после `predev` новый wasm + старый TS → пустые фото.

1. **Спека** — tool в `FRC-I.md`, `VERSION_MAX = N`, decoder `v1..vN`, Status.
2. **Rust** — encode/decode; публичный lossy `encode()` пишет `N`; старые — `encode_with_version` / CLI `--bitstream`.
3. **Goldens** — `golden-vN-*.fri` по §10; `cargo test -p frc-i --test golden`.
4. **TS** — `FRC_I_BITSTREAM_VERSION = N` + тест `toBe(N)` **в том же коммите**, что Rust `BITSTREAM_VERSION = N`.
5. **WASM** — пересобрать локально (не коммитить):  
   `npx tsx Apps/Web/scripts/build-frc-i-wasm.ts`  
   или `npm run predev` / `prebuild` в `Apps/Web`. Артефакт gitignored.
6. **Реестры semver продукта** — при релизе пакета: `Products/FRC/package.json`, `flora-versions.json`, `Backend/flora-versions.json`; fixtures — только через regen-скрипт.
7. **CODECS.md / CODECS-IMAGE.md** — строка «frozen vN» (+ stamp `CODECS.md` Version/Date при материальном изменении реестра).
8. **Mobile** — `FRC_VERSION_MAX = FRC_I_BITSTREAM_VERSION` в `Apps/Mobile/lib/frcImageCache.ts` + native rebuild + encode/decode smoke.

### Минимальная проверка согласования (из корня репо, после сборки wasm)

```sh
# 0) собрать wasm (если ещё нет public/frc/frc_i_wasm.wasm)
npx tsx Apps/Web/scripts/build-frc-i-wasm.ts

# 1) TS constant == wasm high byte
node --import tsx -e "
import { readFileSync } from 'node:fs';
import { FrcICodec, FRC_I_BITSTREAM_VERSION, FRC_I_WASM_ABI_VERSION } from '@flora/frc-i';
const wasm = readFileSync('Apps/Web/public/frc/frc_i_wasm.wasm');
const c = await FrcICodec.load(new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } }));
if (c.bitstreamVersion !== FRC_I_BITSTREAM_VERSION || c.abiVersion !== FRC_I_WASM_ABI_VERSION) {
  console.error({ ts: FRC_I_BITSTREAM_VERSION, abi: FRC_I_WASM_ABI_VERSION, wasm: c.bitstreamVersion, wasmAbi: c.abiVersion });
  process.exit(1);
}
console.log('FRC-I gate OK', { bitstream: c.bitstreamVersion, abi: c.abiVersion });
"

# 2) packages
npm run test --workspace=@flora/frc-i
cargo test -p frc-i --test golden
```

Если шаг 1 падает — **не** дебажить миграции/`post_images`: сначала gate.

---

## Что не трогать при bump

- Схему БД / миграции: opaque FRI bytes + `content_type`; wire bump ≠ ALTER.
- `Artifacts/contract-fixtures/**` и `Documents/test-vectors/**` руками.
- Immutable / decode-freeze goldens прошлых версий «под новый кодер» (таблица выше).
- `FRC_I_WASM_ABI_VERSION` — только при смене C ABI wasm-экспортов, не при каждом wire bump.

---

## Связанные пути

| Роль | Путь |
| --- | --- |
| Ядро | `Products/FRC/crates/frc-i` |
| WASM crate | `Products/FRC/crates/frc-i-wasm` |
| TS + gate | `Products/FRC/ts/src/index.ts` |
| Web worker | `Apps/Web/lib/frcImageWorker.ts` → `/frc/frc_i_wasm.wasm` |
| Сборка wasm | `Apps/Web/scripts/build-frc-i-wasm.ts` |
| Ingest (сервер) | `frc-i-integration` (тот же Rust `BITSTREAM_VERSION`) |
