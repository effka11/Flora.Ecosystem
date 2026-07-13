//! FAC (Flora Audio Codec) — эталонная реализация битстрима v0.
//!
//! Нормативная спецификация: `docs/codecs/FAC.md`. Чистый Rust без unsafe и без
//! внешних зависимостей — переносим на wasm32 (E2E-голосовые кодируются на клиенте,
//! см. `docs/codecs/CODECS.md`) и пригоден для FFI.

pub mod bands;
pub mod bitio;
pub mod container;
pub mod mdct;

mod alloc;
mod codec;
mod energy;
mod error;
mod qmath;

pub use codec::{Config, Decoder, Encoder, FRAME_N};
pub use error::Error;
