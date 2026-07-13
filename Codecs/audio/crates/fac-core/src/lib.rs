//! FAC (Flora Audio Codec) — эталонная реализация битстрима v0.
//!
//! Нормативная спецификация: `docs/codecs/FAC.md`. Чистый Rust без unsafe и без
//! внешних зависимостей — переносим на wasm32 (E2E-голосовые кодируются на клиенте,
//! см. `docs/codecs/CODECS.md`) и пригоден для FFI.
//!
//! ```
//! use fac_core::{Config, Decoder, Encoder, FRAME_N};
//!
//! let cfg = Config { sample_rate: 48_000, channels: 1, bitrate_bps: 64_000 };
//! let mut enc = Encoder::new(cfg)?;
//! let mut dec = Decoder::new(48_000, 1)?;
//!
//! let pcm = vec![0.25f32; FRAME_N]; // один hop, interleaved f32
//! let packet = enc.encode_frame(&pcm)?;
//! let decoded = dec.decode_frame(&packet)?;
//! assert_eq!(decoded.len(), FRAME_N);
//! # Ok::<(), fac_core::Error>(())
//! ```

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
