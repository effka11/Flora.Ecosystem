//! Порт `Flora.Shared` — низкоуровневые утилиты без бизнес-логики (agents.md).
//!
//! Паритет с C# доказывается golden-векторами `documents/test-vectors/backend-parity/`
//! (генерация из эталона: `scripts/generate-golden-vectors.ps1`).

pub mod config;
pub mod dotnet_time;
pub mod flora_uuid;
pub mod latin_identifiers;
pub mod npgsql;
pub mod ordinal;
pub mod uuid_v5;
