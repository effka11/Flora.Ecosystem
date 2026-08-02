//! FRC-A (Flora Relativistic Codec — Audio) — эталонная реализация битстрима v0.
//!
//! Нормативная спецификация: `Documents/codecs/FRC-A.md`. Чистый Rust без unsafe и без
//! внешних зависимостей — переносим на wasm32 (E2E-голосовые кодируются на клиенте,
//! см. `Documents/codecs/CODECS.md`) и пригоден для FFI.
//!
//! ```
//! use frc_a_core::{Config, Decoder, Encoder, FRAME_N};
//!
//! let cfg = Config { sample_rate: 48_000, channels: 1, bitrate_bps: 64_000 };
//! let mut enc = Encoder::new(cfg)?;
//! let mut dec = Decoder::new(48_000, 1)?;
//!
//! let pcm = vec![0.25f32; FRAME_N]; // один hop, interleaved f32
//! let packet = enc.encode_frame(&pcm)?;
//! let decoded = dec.decode_frame(&packet)?;
//! assert_eq!(decoded.len(), FRAME_N);
//! # Ok::<(), frc_a_core::Error>(())
//! ```

pub mod bands;
pub mod bitio;
pub mod container;
pub mod mdct;
pub mod rangecoder;

mod alloc;
mod codec;
mod energy;
mod error;
mod fft;
mod pvq;
mod qmath;
mod transform;
mod trim;

pub use codec::{Config, Decoder, Encoder};
pub use error::Error;
pub use transform::FRAME_N;
