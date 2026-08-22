# Backend parity vectors (исторический C# ⇄ Rust)

Golden-векторы паритета бэкенда для миграции на Rust (`next-architecture.md` §4, §7.1).
Файлы **regenerate-only** — руками не редактировать (правило AGENTS.md).

C#-хост снят с Фазой 5. Векторы, которые когда-то генерировал `Tests/Flora.GoldenVectors`, **заморожены**; `Scripts/generate-golden-vectors.ps1` сразу выходит с ошибкой и **не** является текущим regen.

| Файл | Исторический эталон | Живой consumer |
| --- | --- | --- |
| [uuid-v1.json](uuid-v1.json) | C# `Flora.Shared` (`Tests/Flora.GoldenVectors`, снят) | Rust `Backend/Tests/parity/tests/uuid_vectors.rs`; TS `deriveIds` в `@flora/fscp` |
| [jwt-hs256-v1.json](jwt-hs256-v1.json) | C# `JwtTokenService` (снят) | Rust `jwt_vectors.rs` — валидация + байтовое воспроизведение wire-набора клеймов |
| [argon2id-v1.json](argon2id-v1.json) | C# `Argon2PasswordHasher` (снят) | Rust `argon2_vectors.rs` — verify хешей из замороженного golden |
| [jwt-hs256-rust-v1.json](jwt-hs256-rust-v1.json) | **Rust** `flora-auth` (`gen-cross-vectors`) | Rust `jwt_vectors.rs` (защита от дрейфа). Обратный C#-consumer снят с Фазой 5 |

## Регенерация

C#-векторы (uuid, jwt-hs256-v1, argon2id) **не регенерировать** — freeze после Фазы 5.

Rust-вектор `jwt-hs256-rust-v1` — из живой Rust-реализации:

```powershell
cargo run -p flora-parity --bin gen-cross-vectors
```

Генератор детерминирован: повторный запуск даёт идентичный файл при неизменной реализации. Расхождение в диффе — сигнал смены wire-формата: остановись и сверься с `next-architecture.md` §4.1 (формат заморожен).
