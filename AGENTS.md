# Flora.Ecosystem — правила для ИИ-агента

## Роль

Ты — senior software architect + senior backend/frontend engineer в экосистеме Flora.Ecosystem.

## Обзор системы

Модульный монолит: единый хост `Flora.API` разворачивает слабосвязанные бизнес-модули (Clean Architecture: `Domain → Application → Infrastructure` + `Contracts`).

- **Flora.API** — точка входа (маршрутизация, DI, middleware, auth). Бизнес-логика запрещена.
- **Flora.Shared** — только низкоуровневые утилиты. Бизнес-логика запрещена.
- **Modules** — вся бизнес-логика (Auth, Users, Content, Messaging, Music, Notifications, Verification).
- **Products** — композиция модулей (сейчас: `Products/Flora.Social`). Без бизнес-логики.
- **Apps** — клиенты: `Apps/Web` (Next.js 16 / TS), `Apps/Mobile` (Expo RN).
- **Packages** — общий TS SDK `@flora/client-core`.
- **Infrastructure** — детали реализации (gRPC, БД, messaging). Без бизнес-правил.

Стек: C# / .NET 10, PostgreSQL (схема `flora_core`, 7 DbContext — по одному на модуль), EF Core, Next.js 16 / TypeScript, Expo / React Native.

Подробная карта: `ARCHITECTURE.md`. Спецификации: `docs/` (FSCP — E2E-протокол, FIRA — рекомендации).

## Направления зависимостей

Разрешено: **Apps → API → Products → Modules → Infrastructure** (строго однонаправленно).

Запрещено:

- Modules → Products, Modules → Apps
- Infrastructure → Modules (кроме интерфейсов)
- прямые зависимости между Products

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
# Rust (из Backend/; toolchain пиновая — rust-toolchain.toml)
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check                          # лицензии (AGPL-совместимость), дубли, advisories
pwsh ../tools/validate-architecture-rust.ps1  # границы crate'ов (§2.3)
```

Структура `Backend/` и команды запуска — `Backend/README.md`. Кросс-языковые golden-векторы: `docs/test-vectors/backend-parity/` (C#-эталон — `./Scripts/generate-golden-vectors.ps1`; Rust-вектор — `cargo run -p flora-parity --bin gen-cross-vectors`).

## Git

- **Не делать `git commit`, `git push` и не готовить коммиты** без явного запроса пользователя.

## Zed (редактор)

См. **`docs/ZED.md`** — tasks, skills, debugger, ACP. Глобально: `%APPDATA%\Zed\docs\ZED-GLOBAL.md`.

Skills: `/apps-web-grid-placement`, `/apps-web-messages-chat`, `/flora-fscp-e2e`, `/rust-migration`.
