//! Ошибки ядра FSA. Ядро портируемо (wasm32) — без `thiserror`/`anyhow`.

use std::error::Error;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsaError {
    /// Документ ссылается на поле, не объявленное в профиле.
    UnknownField { field: String },
    /// Профиль не проходит валидацию (см. `SearchProfile::validate`).
    InvalidProfile { reason: String },
}

impl fmt::Display for FsaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownField { field } => {
                write!(f, "document references unknown profile field `{field}`")
            }
            Self::InvalidProfile { reason } => write!(f, "invalid search profile: {reason}"),
        }
    }
}

impl Error for FsaError {}
