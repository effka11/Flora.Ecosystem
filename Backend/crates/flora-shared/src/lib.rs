//! Порт `Flora.Shared` — низкоуровневые утилиты без бизнес-логики (AGENTS.md).
//!
//! Паритет с C# доказывается golden-векторами `Documents/test-vectors/backend-parity/`
//! (генерация из эталона: `Scripts/generate-golden-vectors.ps1`).

pub mod config;
pub mod dotnet_time;
pub mod flora_uuid;
pub mod latin_identifiers;
pub mod npgsql;
pub mod ordinal;
pub mod uuid_v5;
