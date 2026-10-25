# FGCE — движок двумерной композиции

FGCE рисует по одному кадру: хост отправляет запрос, движок возвращает пиксели.
Растр и вектор используют одну целочисленную координату (**sPx**), решётка —
5/15, число клеток окна следует за живым размером окна. У ядра нет зависимостей
и `unsafe`; wasm-адаптер — единственный крейт с сырыми указателями на границе.

Продукт самодостаточен. Скопируйте этот каталог куда угодно и соберите его: ему
не нужны репозиторий-хост, корень workspace или внешние документы.

## Документация

| Документ | Содержание |
|----------|------------|
| [`docs/fgce.md`](docs/fgce.md) | нормативный закон композиции: sPx, решётка, дерево боксов, эталоны, растр, вектор, клип, кадр |
| [`docs/wasm-abi.md`](docs/wasm-abi.md) | C ABI wasm-адаптера и его бинарный wire-протокол |
| [`docs/questions.md`](docs/questions.md) | решения по спорным местам спецификации |
| [`CHANGELOG.md`](CHANGELOG.md) | история версий и ограничения `0.1.0-alpha` |
| [`RELEASE.md`](RELEASE.md) | чек-лист выпуска, ворота и запись проверки |
| [`LICENSE`](LICENSE) | GNU AGPL v3 only (AGPL-3.0-only) |
| [`NOTICE.md`](NOTICE.md) | copyright, условия AGPLv3 §7 и товарные знаки |

## Состав

Ядро `crates/fgce`:

| Файл | Содержание |
|------|------------|
| `src/lib.rs` | `Engine`, `submit`, публичные реэкспорты, лимиты крейта |
| `src/contract.rs` | запросы, ответы, ошибки, типы геометрии и цвета |
| `src/dispatch.rs` | один `match` по `Request` |
| `src/spx.rs` | грамматика масштаба, длины и края (§3.1–§3.3, §4.3) |
| `src/lattice.rs` | живая решётка окна (§3.4) |
| `src/frame.rs` | буфер кадра, стек клипа, жизненный цикл, отрисовка дерева (§5.2, §7) |
| `src/store.rs` | загрузка и удаление изображений, premultiplied-store (§5.3, §6) |
| `src/fill.rs` | сплошной прямоугольник в спаны (§8.1) |
| `src/round.rs` | скруглённые боксы: разрешение радиуса, быстрая заливка, маска `DstOut`, обводка (§8.5) |
| `src/blit.rs` | растровая выборка `Crisp` и `Area` (§8.2) |
| `src/span.rs` | единственный писатель байтов кадра (§7, §11) |
| `src/color.rs` | `pm`, `over`, `straight` (§6) |
| `src/tree.rs` | узлы, эталоны, канонические боксы, `zero` (§4, §5.5) |
| `src/place.rs` | канонический и живой проходы, обратный `pin` у `Place` (§4.6, §4.7) |
| `src/vector.rs` | разворачивание пути, растеризация покрытия, обводка (§8.3, §8.4) |

Адаптер, клиенты и conformance:

| Путь | Содержание |
|------|------------|
| `crates/fgce-wasm/src/lib.rs` | C ABI: хэндл движка, alloc/free, submit, ответ |
| `crates/fgce-wasm/src/wire.rs` | кодек запросов и ответов на границе wasm |
| `bindings/ts/src/protocol.ts` | TypeScript-зеркало wire-протокола |
| `bindings/ts/src/engine.ts` | `FgceEngine` — фасад над экспортами wasm |
| `bindings/ts/test` | векторы ABI, эталонные байты протокола и опциональный wasm-smoke |
| `tests/abi-vectors` | языконезависимые байты запросов и ответов для любого клиента |
| `tests/conformance` | `fgce-conformance`: карта §12, fuzz, benchmark, фикстуры |

Клиент — тонкий слой над C ABI; правила добавления нового языка — в
[`bindings/readme.md`](bindings/readme.md).

## Команды

```sh
cargo test --workspace                          # kernel, adapter and conformance
cargo test -p fgce                              # kernel unit tests
cargo test -p fgce-conformance                  # §12 conformance suite
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p fgce-wasm --target wasm32-unknown-unknown --release

npm install
npm run typecheck                               # TS reference binding
npm test                                        # ABI vectors + protocol goldens; engine smoke needs FGCE_WASM_PATH

pwsh ./scripts/check-standalone.ps1             # host + wasm32 outside the product workspace
pwsh ./scripts/check-release.ps1                # version + license + full release gates
```

Smoke-тест wasm читает путь к артефакту из `FGCE_WASM_PATH`:

```sh
FGCE_WASM_PATH=target/wasm32-unknown-unknown/release/fgce_wasm.wasm npm test
```

## Релиз 0.1.0-alpha

Текущая версия — `0.1.0-alpha`; она записана в `crates/fgce`, `crates/fgce-wasm`,
`tests/conformance` и `package.json`. Тег выпуска — `fgce/v0.1.0-alpha`. Крейты не
публикуются на crates.io (`publish = false`): поставка идёт копированием каталога.
Полный чек-лист, ворота и запись проверки — в [`RELEASE.md`](RELEASE.md).

## Поставка

`crates/fgce` — публичная поверхность. Его манифест использует литеральные поля и
никогда не наследует их из workspace, поэтому каталог можно скопировать в любой
хост и собрать с path-зависимостью:

```toml
[dependencies]
fgce = { path = "third_party/fgce", version = "=0.1.0-alpha" }
```

Адаптер (`crates/fgce-wasm`), TS-клиент (`bindings/ts`) и набор conformance
(`tests/conformance`) — части этого workspace. Геометрия страниц, измерение
текста, ввод и презентация принадлежат хосту и здесь не поставляются.

`LICENSE` и `NOTICE.md` лежат в каталоге крейта и едут вместе с ним: копия
`crates/fgce` остаётся лицензионно полной без корня репозитория.
