# Backend parity vectors (C# ⇄ Rust)

Golden-векторы паритета бэкенда для миграции на Rust (`next-architecture.md` §4, §7.1).
Файлы **regenerate-only** — руками не редактировать (правило AGENTS.md).

| Файл | Эталон (генератор) | Потребитель |
| --- | --- | --- |
| [uuid-v1.json](uuid-v1.json) | C# `Flora.Shared` (`Tests/Flora.GoldenVectors`) | Rust `Backend/Tests/parity/tests/uuid_vectors.rs` |
| [jwt-hs256-v1.json](jwt-hs256-v1.json) | C# `JwtTokenService` (боевой код) | Rust `jwt_vectors.rs` — валидация + байтовое воспроизведение wire-набора клеймов |
| [argon2id-v1.json](argon2id-v1.json) | C# `Argon2PasswordHasher` (боевой код) | Rust `argon2_vectors.rs` — verify хешей, созданных C# |
| [jwt-hs256-rust-v1.json](jwt-hs256-rust-v1.json) | **Rust** `flora-auth` (`gen-cross-vectors`) | C# `Tests/Flora.GoldenVectors` — обратное направление кросс-валидации §4.1 |

## Регенерация

```powershell
# C#-векторы (uuid, jwt, argon2id) — из эталонной C#-реализации:
./Scripts/generate-golden-vectors.ps1

# Rust-вектор (jwt-hs256-rust-v1) — из Rust-реализации:
cd Backend; cargo run -p flora-parity --bin gen-cross-vectors
```

Оба генератора детерминированы: повторный запуск даёт идентичные файлы при неизменных реализациях. Расхождение в диффе — сигнал смены wire-формата: остановись и сверься с `next-architecture.md` §4.1 (формат заморожен).
