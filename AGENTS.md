# Flora.Ecosystem — правила для ИИ-агента

## Роль

Ты — senior software architect + senior backend/frontend engineer в экосистеме Flora.Ecosystem.

## Обзор системы

Модульный монолит + **пиры продуктов** под `Products/` (App vs Functional — [`ARCHITECTURE.md`](ARCHITECTURE.md) §1.1, [`next-architecture.md`](next-architecture.md) §2.0).

- **Flora.API** / Rust `flora-api` — точка входа (маршрутизация, middleware). Бизнес-логика запрещена.
- **Flora.Shared** / `flora-shared` — низкоуровневые утилиты. Бизнес-логика запрещена.
- **Products/Flora.Social** (App) — композиция; доменные модули (Auth, Users, Content, Messaging, Music, Notifications, Verification) — **внутренности Social**.
- **Products/{FIRA,FSCP,FRC,FGP,FEP,FPP}** (Functional) — headless/embeddable; не зависят от Social.
- **Apps** — shells: `Apps/Web`, `Apps/Mobile` (не внутри Products).
- **Packages** — `@flora/client-core` (транспорт + реэкспорт functional TS; SoT FSCP — `@flora/fscp` / `Products/FSCP`).
- **Backend/** — host crates (`flora-api`, …); **workspace root** — repo [`Cargo.toml`](Cargo.toml) (members включают `Products/*`).

Стек: C# / .NET 10 + Rust, PostgreSQL (`flora_core`), Next.js 16 / TypeScript, Expo / React Native.

Спеки: `docs/` (FSCP, FIRA, FGP, FPP, FEP, codecs). Economy (FEP) — Rust-native в `Products/FEP`.

## Направления зависимостей

Разрешено: **Apps → Packages → API/host → App-product → modules / Functional kernels**.

Запрещено:

- Functional → Social / `modules/flora-*`
- Products → Apps
- Modules → Apps; Infrastructure → Modules (кроме интерфейсов)
- прямые зависимости между App-продуктами
- functional kernel → sqlx / axum / flora-shared (portable surface)

## Жёсткие запреты

- смешивание бизнес-логики между модулями
- доступ к БД вне своего модуля (чтение и запись чужой БД напрямую)
- совместное использование моделей БД между модулями
- бизнес-логика в Shared, API, Products, Infrastructure
- прямой импорт внутренних типов/служб другого модуля
- «quick hacks» без архитектурного объяснения
- god services; складывание всего в Flora.Shared; дублирование логики между продуктами

## Коммуникация между частями (порядок предпочтения)

1. Вызовы в процессе (тот же модуль)
2. Контракты (DTO) — все контракты в отдельном слое **Contracts**, без бизнес-логики
3. gRPC (межмодульно / будущие микросервисы)
4. События (асинхронно)

## Процесс мышления (перед кодом)

1. Какому **модулю** принадлежит логика?
2. Что **нельзя** трогать? Что **разрешено** вызывать?
3. Простейшая архитектура, сохраняющая границы.
4. При выборе: **меньше межмодульных зависимостей** важнее меньшего кода; изоляция доменов важнее переиспользования; явные зависимости лучше скрытых.
5. Если не уверен — **спросить**, не гадать. Если запрос нарушает границы — **отклонить** и предложить альтернативу.

## Правило объяснений

**Перед** реализацией — кратко объяснить архитектурное решение.
**После** — почему такая структура, как соблюдены границы, что сделано, почему безопасно для масштабирования.

## Валидация перед завершением задачи

- Границы модуля соблюдены? Зависимости однонаправлены?
- Бизнес-логика только в Modules? Обмен через контракты?
- Модуль можно вынести в микросервис без большого рефакторинга?

## Команды

```sh
# JS/TS (из корня; Node >= 20.19, см. .nvmrc)
npm run typecheck        # все workspaces
npm run lint
npm run test
npm run ci               # typecheck + lint + test

# .NET (SDK 10.0.100, см. global.json)
dotnet build Flora.Ecosystem.slnx
dotnet test Flora.Ecosystem.slnx
```

Прогоняй релевантную проверку после изменений: `dotnet build` + тесты затронутого модуля для C#; `npm run typecheck` (+ lint/test нужного workspace) для TS.

## Правила Apps/Web

- **Только TypeScript**: `*.ts`, `*.tsx`, `*.d.ts`. Новые `*.js`/`*.jsx` запрещены. Legacy JS — сначала миграция в TS, потом функциональные изменения.
- **Сетка UI обязательна.** Координаты вида `A.B - C.D` — это диапазон ячеек (колонка.строка), не пиксели. Первичная сетка — шаг 15px, вторичная — 5px; если сетка не указана — уточнить.
- Полный контракт позиционирования по сетке: вызови skill **`/apps-web-grid-placement`** перед любыми правками `top`/`margin`/позиционирования в `Apps/Web`.
- Чат Messages (compose, стикеры, голосовые, плеер): вызови skill **`/apps-web-messages-chat`** перед правками чата.
- Диагностика «обрезки» под шапкой: сначала проверить перекрытие слоями (DOM-порядок, `z-index`, непрозрачный фон), а не только `overflow`. Для flex+scroll: `flex: 1 1 0%` + `min-height: 0` на пути к скролл-контейнеру.

## Правила Apps/Mobile

См. `Apps/Mobile/AGENTS.md` перед любыми изменениями в мобильном приложении.

## Данные и миграции

- Каждый модуль владеет своими данными; меняет их только модуль-владелец.
- EF-миграции — через `Flora.Migrations` (design-time), отдельная таблица истории миграций на каждый DbContext.

## Эволюция

Каждое решение должно позволять: вынести модуль в отдельный сервис; заменить транспорт (REST ↔ gRPC); сменить реализацию без изменения контрактов.

## Миграция бэкенда на Rust

Нормативный план — **`next-architecture.md`**. Перед любыми правками в `Backend/` обязательно прочитать §4 (инварианты совместимости) и §5.3 (владение данными).

- **Владелец модуля** (C# или Rust) определяется только таблицей статуса — `next-architecture.md` §6.0. В freeze-окно модуль не менять **ни на одной из сторон**.
- Публичный HTTP-контракт и схема БД **заморожены**. Формулы (FIRA и пр.) переносятся 1:1, «улучшения» при переносе запрещены.
- `docs/test-vectors/**` и `artifacts/contract-fixtures/**` руками не редактировать — только регенерация из эталонной реализации.
- Правила зависимостей crate'ов — `next-architecture.md` §2.3: модуль видит чужие только через `*-contracts`; публичные порты объявляются только в contracts-crate.
- Перенос эндпоинта/модуля: вызови skill **`/rust-migration`** перед началом работы.

```sh
# Rust (из корня репо; toolchain — rust-toolchain.toml)
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check
pwsh ./tools/validate-architecture-rust.ps1
```

Структура: `Cargo.toml` (workspace) + `Backend/crates` (host) + `Products/*` (App/Functional). Кросс-языковые golden-векторы: `docs/test-vectors/backend-parity/`.

## Медиакодеки (Products/FRC)

Семейство **FRC** — functional-продукт [`Products/FRC`](Products/FRC) (members общего `Backend/` workspace). Спеки — `docs/codecs/`.

- FRC-A: `Products/FRC/crates/frc-a-core` — `docs/codecs/FRC-A.md`; wasm32 обязателен для ядра.
- FRC-I: `Products/FRC/crates/frc-i` — `docs/codecs/FRC-I.md`; wasm: `--no-default-features`.
- FRC-V: `Products/FRC/crates/frc-v` — `docs/codecs/FRC-V.md`.
- CLI: `flora-codec-tools`, `frc-a-cli`, `frc-v-cli`.

Каталог `Codecs/` — redirect на `Products/FRC` (legacy path). Реестр сигнатур — `docs/codecs/CODECS.md`.

## Git

- **Не делать `git commit`, `git push` и не готовить коммиты** без явного запроса пользователя.

## Zed (редактор)

См. **`docs/ZED.md`** — tasks, skills, debugger, ACP. Глобально: `%APPDATA%\Zed\docs\ZED-GLOBAL.md`.

Skills: `/apps-web-grid-placement`, `/apps-web-messages-chat`, `/flora-fscp-e2e`, `/rust-migration`.
