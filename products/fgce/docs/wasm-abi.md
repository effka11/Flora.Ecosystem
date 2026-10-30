# FGCE — C ABI адаптера `fgce-wasm` v3

Статус: `0.2.0`-адаптер, ABI `3`. Закон ядра — [`fgce.md`](./fgce.md); этот документ описывает только границу «хост ↔ wasm» и формул §5–§8 не меняет.

**v3:** `DrawTree` (код 27), `StrokeRoundRect` (28), `FillLattice` (29), `DebugGrid` (30), `DebugHover` (31), `DebugLabel` (32); `StrokeAlign::Center` (код 2); поле `peak` в каждом `stroke?` (код 0/1); `EntityKind::Empty` (тег 5); `radius?` у `FillRect`. `Stroke.width_q8` (1/256 sPx) вместо целого `width` — та же позиция и тот же `u32`; у `DebugGridStyle` два опциональных цвета подписей. Старые запросы со штрихом и `FillRect` несовместимы: их форма выросла на поле, а ширина сменила единицу.

**v2:** `radius?` у `Entity` и `Blit` (§8.5), `EntityKind::Box` (тег 4), `Blend::DstOut` (код 3), ошибка `BadRadius` (код 23).

| Роль | Путь |
| --- | --- |
| Адаптер (Rust) | `crates/fgce-wasm` |
| Клиент (TS) | `bindings/ts` → `fgce` |
| Сборка wasm | `cargo build -p fgce-wasm --target wasm32-unknown-unknown --release` |
| Эталонные байты | `tests/abi-vectors` (запрос/ответ), `bindings/ts/test/protocol.test.ts` (порядок полей) |

§10 `fgce.md`: ядро не имеет экспортов, JS не может звать `submit` напрямую. Адаптер — единственный крейт FGCE с `unsafe` (`unsafe_code = "allow"`); он копирует `Frame`/`Pixels` через границу и не является второй реализацией растра.

## 1. C ABI

| Экспорт | Сигнатура | Смысл |
| --- | --- | --- |
| `fgce_abi_version` | `() -> u32` | Версия ABI (`3`), не версия ядра |
| `fgce_engine_new` | `() -> *mut HostEngine` | Движок + буфер последнего ответа |
| `fgce_engine_free` | `(*mut HostEngine)` | Уничтожает движок; `null` игнорируется |
| `fgce_alloc` | `(len: usize) -> *mut u8` | Буфер запроса; `len == 0` → `null` |
| `fgce_free` | `(*mut u8, len: usize)` | Освобождает пару из `fgce_alloc` |
| `fgce_submit` | `(*mut HostEngine, *const u8, usize) -> i32` | Один запрос; `0` — успех, `-1` — `null` движок или `null` запрос при `len > 0` |
| `fgce_response_ptr` | `(*const HostEngine) -> *const u8` | Начало ответа |
| `fgce_response_len` | `(*const HostEngine) -> usize` | Длина ответа |

### 1.1. Границы адаптера

Адаптер не владеет геометрией поверхностей: layout, шейпинг и таймер в него не
входят (§«Цели и не-цели» `fgce.md`). Хост измеряет ввод и текст, считает боксы
своим layout-модулем и передаёт готовые числа в сущности FGCE.

Правила владения:

- Запрос живёт в буфере хоста, выделенном `fgce_alloc`; после `fgce_submit` его можно освободить `fgce_free`. Указатели хоста адаптер не разыменовывает: все переменные payload'ы адресуются offset'ами внутри самого буфера запроса.
- Ответ — `Vec<u8>` внутри движка; он действителен **до следующего `fgce_submit`**. Хост копирует нужное (в TS — `ImageData`/`new Uint8Array`), иначе данные перезапишет следующий запрос.
- Линейная память wasm может расти при любом вызове: после каждого вызова хост обязан перечитать `memory.buffer` (view, созданные до вызова, детачируются). TS-фасад читает ответ заново на каждом `submit`.
- Малформед-запрос — не `-1`: это ответ `Error(BufferLayout)`. `-1` остаётся только `null`-указателям.

## 2. Кадрирование запроса

Порядок байтов — little-endian. Примитивы: `u8`/`i8`/`bool` (0/1) — 1 байт, `u32`/`i32` — 4, `u64`/`i64` — 8.

- Опциональные поля — пара «`bool` присутствия + значение». Пропущенное обязательное поле — ошибка ядра (`fgce.md` §4).
- Переменные payload'ы (`verbs`, `children`, `Upload.bytes`) — пара `u32 offset`, `u32 len`; `offset` отсчитывается **от начала буфера запроса**. Физически блобы дописаны в конец запроса, после всех фиксированных полей: декодер читает пару на месте и уходит по offset. Хост обязан дописывать блобы в конец, иначе поля, идущие следом, окажутся внутри блоба (`BufferLayout`).
- `edges` — четыре ребра подряд, каждое: `u8` тег + payload.
  - `0` Grid: `i32 primary`, `bool fine?` + `u8 fine`, `bool spx?` + `i32 spx`.
  - `1` Pixel: `i32 value`.
- `rect` — `i32 x1, y1, x2, y2`. `color` — `u8 r, g, b, a`. `inset?` — `bool` + `i32 left, top, right, bottom`. `blend?` — `bool` + `u8` (`0 srcOver`, `1 src`, `2 clear`, `3 dstOut`).
- `radius?` — `bool` + `u8` тег: `0` Edge + `edges`-запись одного ребра (§4.3 `fgce.md`), `1` Percent + `u8 value` (`0..=50`).

### 2.1. Таблица opcode

| Op | Код | Payload после opcode |
| --- | --- | --- |
| `Info` | 1 | — |
| `Grid` | 2 | `u32 k` |
| `Length` | 3 | `u32 n, u32 k` |
| `Lattice` | 4 | `u32 spanX, spanY, step`, `i8 pinX, pinY` |
| `EdgePx` | 5 | `edges`, `u32 k` |
| `Measure` | 6 | `verbs(off/len)`, `fill?`, `stroke?` |
| `Begin` | 7 | `u32 width, height` |
| `End` | 8 | — |
| `ReadPixels` | 9 | `rect`, `u8 alpha` (`0 premul`, `1 straight`) |
| `Upload` | 10 | `u32 id, width, height, stride`, `u8 format`, `u8 alpha`, `bytes(off/len)` |
| `Drop` | 11 | `u32 id` |
| `FillRect` | 12 | `rect`, `color`, `blend?`, `radius?` |
| `Entity` | 13 | `u32 id`, `kind`, `bool onGrid?` + `bool`, `edges`, `bool align?` + `i8 x, y`, `blend?`, `radius?` |
| `Group` | 14 | `u32 id, parent`, `children(off/len)`, `i8 pinX, pinY`, `bool snap`, `inset?` |
| `Arbitrary` | 15 | `u32 id, parent`, `bool onGrid?` + `bool`, `edges`, `children(off/len)`, `i8 pinX, pinY`, `bool snap`, `inset?` |
| `Show` | 16 | `u32 id`, `rect` |
| `Place` | 17 | `u32 id`, `rect` |
| `Remove` | 18 | `u32 id` |
| `Snapshot` | 19 | — |
| `DefineReference` | 20 | `u32 id, canonW, canonH, k, d`, `i8 pinX, pinY`, `u32 enterCols, enterRows` |
| `UseReference` | 21 | `u32 id` |
| `ClipPush` | 22 | `rect` |
| `ClipPop` | 23 | — |
| `Blit` | 24 | `u32 id`, `rect dest`, `rect src`, `u8 sample` (`0 crisp`, `1 area`), `tint?`, `blend?`, `radius?` |
| `FillPath` | 25 | `verbs(off/len)`, `u8 rule`, `color`, `blend?` |
| `StrokePath` | 26 | `verbs(off/len)`, `stroke`, `color`, `blend?` |
| `DrawTree` | 27 | — |
| `StrokeRoundRect` | 28 | `rect`, `radius?`, `stroke`, `color`, `blend?` |
| `FillLattice` | 29 | `rect`, `u32 step`, `bool primaryStep?` + `u32`, `color fine`, `color primary`, `blend?` |
| `DebugGrid` | 30 | `bool style?` + `color base`, `color tip`, `bool labelBase?` + `color`, `bool labelTip?` + `color`, `u8 labelAlpha`, `u8 labelScale` |
| `DebugHover` | 31 | `bool point?` + `i32 x, y` |
| `DebugLabel` | 32 | `u32 id`, `bool text?` + `text(off/len)` |

`fill?` = `bool` + `u8 rule` (`0 nonZero`, `1 evenOdd`).

`stroke?` = `bool` + `u32 widthQ8` (1/256 sPx), `u8 align` (`0 inside`, `1 outside`, `2 center`), `u8 join` (`0 miter` + `u32 limitQ8`, `1 bevel`, `2 round`), `u8 cap` (`0 butt`, `1 square`, `2 round`), `u8 peak` (`0 light`, `1 nominal`). Целая ширина `n` sPx — это `n · 256`; `0` — `BadStroke`.

`kind` (тег `u8`):

| Тег | Вид | Payload |
| --- | --- | --- |
| 0 | `Photo` | `u8 format`, `u32 image`, `tint?` |
| 1 | `Glyph` | `u8 format`, `u32 image`, `tint?` |
| 2 | `Vector` | `verbs(off/len)`, `fill?`, `stroke?`, `color` |
| 3 | `Flat` | `color` |
| 4 | `Box` | `fill?`, `stroke?`, `color` |
| 5 | `Empty` | — |

`format`: `0 rgb8`, `1 rgba8`, `2 alpha8`. `tint?` = `bool` + `color`.

`verbs` блоб — записи до конца блоба: `u8` тег + `i32` координаты.

| Тег | Verb | Координаты |
| --- | --- | --- |
| 0 | `Move` | `x, y` |
| 1 | `Line` | `x, y` |
| 2 | `Quad` | `cx, cy, x, y` |
| 3 | `Cubic` | `c0x, c0y, c1x, c1y, x, y` |
| 4 | `Close` | — |

`children` блоб — `len` раз по `u32` id узла. `text` блоб `DebugLabel` — UTF-8, не длиннее 64 байт; длина больше или невалидный UTF-8 — `BufferLayout`.

## 3. Кадрирование ответа

Первый байт — вид ответа; `0 none`, `1 info`, `2 grid`, `3 length`, `4 lattice`, `5 edgePx`, `6 measure`, `7 frame`, `8 pixels`, `9 snapshot`, `10 error`.

| Вид | Payload |
| --- | --- |
| `none` | — |
| `info` | `u32 versionLen`, `version` (UTF-8), `u32 maxSide, maxK, maxClip, maxVertices, maxCoord`, `u8 pixelFormat`, `bool premultiplied` |
| `grid` | `u32 fine, primary` |
| `length` | `u32` |
| `lattice` | `u32 countX, countY`, `u64 originX, originY` |
| `edgePx` | `i32` |
| `measure` | `rect` |
| `frame` | `u32 width, height, stride, pixelsLen`, `pixels` |
| `pixels` | `i32 x, y`, `u32 width, height, stride, bytesLen`, `bytes` |
| `snapshot` | `u64 generation`, `u32 count`, `count × { u32 id, parent, i32 x1, y1, x2, y2 }` |
| `error` | `u8 code` |

`version` — версия ядра (`fgce::VERSION` == `CARGO_PKG_VERSION`), не версия ABI.

## 4. Коды ошибок

Порядок объявления `fgce::Error`; TS-клиент несёт те же имена (`FGCE_ERROR_NAMES`).

| Код | Имя | Код | Имя | Код | Имя |
| --- | --- | --- | --- | --- | --- |
| 0 | `ScaleOutOfRange` | 8 | `ClipOverflow` | 16 | `BadArbitrary` |
| 1 | `SurfaceOutOfRange` | 9 | `BadCell` | 17 | `BadInset` |
| 2 | `NotBegun` | 10 | `Overflow` | 18 | `BoxOverflow` |
| 3 | `UnknownImage` | 11 | `BadStroke` | 19 | `OffGrid` |
| 4 | `UnknownNode` | 12 | `BadPath` | 20 | `BadParent` |
| 5 | `ImageTooLarge` | 13 | `BadNudge` | 21 | `ReferenceMissing` |
| 6 | `BufferLayout` | 14 | `BadAnchor` | 22 | `ReferenceBusy` |
| 7 | `ClipUnderflow` | 15 | `BadGroup` | 23 | `BadRadius` |

## 5. Версии и совместимость

- `ABI_VERSION` живёт в `fgce-wasm/src/lib.rs` и дублируется константой в `bindings/ts/src/engine.ts`. Несовпадение — исключение у клиента до первого запроса.
- Смена сигнатур C ABI, кодов opcode, порядка или состава полей запроса/ответа, кодов ошибок — bump `ABI_VERSION`. Смена формул ядра без изменения wire — bump версии ядра (`Info.version`), ABI прежний.
- Версия ABI не выводится из semver ядра: клиент и артефакт могут собраться из разных ревизий.

## 6. Сборка и артефакт

```sh
cargo build -p fgce-wasm --target wasm32-unknown-unknown --release
# → target/wasm32-unknown-unknown/release/fgce_wasm.wasm
```

- Хост копирует артефакт в свой `public`-каталог и не хранит его в git.
- Smoke: `FGCE_WASM_PATH=target/wasm32-unknown-unknown/release/fgce_wasm.wasm npm test` — клиент против свежего wasm.
- Клиент: `await FgceEngine.load("/fgce/fgce_wasm.wasm")` (браузер) или `FgceEngine.load(new Response(bytes))` (Node, тесты).

## 7. Инвариант синхронности

`fgce-wasm/src/wire.rs` (Rust), `bindings/ts/src/protocol.ts` (TS) и этот документ описывают один и тот же байтовый формат. Правка любого из трёх — правка всех трёх в одном изменении; эталонные тесты `tests/abi-vectors` фиксируют байты для всех клиентов, `protocol.test.ts` — порядок полей и offset'ы, smoke `engine.test.ts` — совместимость с реальным артефактом.
