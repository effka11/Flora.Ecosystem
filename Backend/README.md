# Backend — Rust-хост Flora

Rust-воплощение бэкенда Flora по нормативному плану [`next-architecture.md`](../next-architecture.md).
С Фазы 0 `flora-api` — единая точка входа за nginx: нативно отвечает на `/`, `/health`, `/version`,
всё остальное прозрачно проксирует в .NET `Flora.API` (§5.1, strangler fig). Модули переезжают
фазами; владелец каждого модуля — таблица статуса `next-architecture.md` §6.0.

## Структура workspace (§2)

```
Backend/
  Cargo.toml                  # workspace + workspace.dependencies (версии только здесь)
  rust-toolchain.toml         # пиновая версия toolchain
  deny.toml                   # cargo-deny: лицензии (AGPL-совместимость), дубли, advisories
  appsettings.json            # конфиг хоста (семантика ASP.NET, §4.8)
  crates/
    flora-api/                # bin: хост — конфиг, tracing, нативные маршруты, реверс-прокси
    flora-social/             # продукт: композиция модульных роутеров (§2.4)
    flora-shared/             # утилиты: config, uuid v5/v7, latin-identifiers, npgsql-строка
    flora-migrate/            # bin: миграции, история на модуль (__flora_migrations_<module>)
    modules/
      flora-<module>/         # реализация модуля (domain/application/infrastructure/http)
      flora-<module>-contracts/ # DTO + trait-порты; единственное, что видят чужие модули
    infrastructure/
      flora-grpc-bridge/      # переходный межъязыковой мост (§5.2), оживает в Фазе 2a
  tests/
    parity/                   # паритет-харнесс: golden-векторы, contract fixtures, flora-diff
```

Правила зависимостей между crate'ами — §2.3; проверяются `tools/validate-architecture-rust.ps1`
(поверх `cargo metadata`) и самим фактом path-зависимостей.

## Запуск

```sh
cargo run -p flora-api          # хост на Gateway:Listen (default 127.0.0.1:5290)
```

Конфигурация — слои с семантикой ASP.NET (§4.8): `appsettings.json` →
`appsettings.{Environment}.json` → (Development) `appsettings.Local.json` → env-переменные
с `__` (`Jwt__Secret`, `Gateway__DotnetUpstream`, …). Окружение — `FLORA_ENVIRONMENT`
(или `ASPNETCORE_ENVIRONMENT`), по умолчанию Production; каталог конфига — `FLORA_CONFIG_DIR`.
В Development при слабом/пустом `Jwt:Secret` чеканится эфемерный секрет — как у .NET-хоста.

## Проверки

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check
pwsh ../tools/validate-architecture-rust.ps1
```

CI (`.github/workflows/ci.yml`, job `rust`) гоняет всё то же с `--locked`:
`Cargo.lock` закоммичен и является фактической пиновкой зависимостей.

## Паритет с C# (§7)

- **Golden-векторы** `docs/test-vectors/backend-parity/` — UUID v5/v7, JWT HS256 (в обе стороны),
  Argon2id; регенерация только из эталонов (см. README каталога).
- **Contract fixtures** `artifacts/contract-fixtures/` — общие для C#, TS и Rust;
  формы нативных маршрутов хоста фиксируют `crates/flora-api/tests/host_parity.rs`.
- **flora-diff** — семантический дифф двух живых бэкендов:

```sh
cargo run -p flora-parity --bin flora-diff -- \
  --left http://127.0.0.1:5284 --right http://127.0.0.1:5290 \
  --path /health --path /version
```

## Миграции БД

`flora-migrate` применяет миграции модулей, история — отдельная таблица на модуль
(`__flora_migrations_<module>`, продолжение паттерна `__EFMigrationsHistory_*`).
Пока модули на C#, Rust-миграций нет (реестр пуст) — схема заморожена (§5.3):

```sh
cargo run -p flora-migrate -- --dry-run
```
