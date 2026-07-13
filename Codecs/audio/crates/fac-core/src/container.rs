//! Файловый контейнер FACS (FAC.md, «Контейнер FACS»). Транспорт Flora (FSCP/HTTP)
//! передаёт пакеты собственным способом — контейнер нужен инструментам и файлам.

use crate::error::Error;
use crate::transform::FRAME_N;

pub const MAGIC: [u8; 4] = *b"FACS";
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub channels: u8,
    pub sample_rate: u32,
    /// Число сэмплов на канал в исходном сигнале (без кодек-задержки).
    pub num_samples: u64,
}

impl Header {
    pub fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        out[0..4].copy_from_slice(&MAGIC);
        out[4] = VERSION;
        out[5] = self.channels;
        out[6..10].copy_from_slice(&self.sample_rate.to_le_bytes());
        out[10..12].copy_from_slice(&(FRAME_N as u16).to_le_bytes());
        out[12..20].copy_from_slice(&self.num_samples.to_le_bytes());
        out
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() < HEADER_LEN {
            return Err(Error::Truncated);
        }
        if bytes[0..4] != MAGIC {
            return Err(Error::InvalidPacket("bad FACS magic"));
        }
        if bytes[4] != VERSION {
            return Err(Error::InvalidPacket("unsupported FACS version"));
        }
        let frame_n = u16::from_le_bytes([bytes[10], bytes[11]]);
        if frame_n as usize != FRAME_N {
            return Err(Error::InvalidPacket("unsupported frame size"));
        }
        Ok(Self {
            channels: bytes[5],
            sample_rate: u32::from_le_bytes(bytes[6..10].try_into().expect("slice len 4")),
            num_samples: u64::from_le_bytes(bytes[12..20].try_into().expect("slice len 8")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_roundtrip() {
        let h = Header {
            channels: 2,
            sample_rate: 48_000,
            num_samples: 123_456_789,
        };
        assert_eq!(Header::parse(&h.to_bytes()).unwrap(), h);
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(Header::parse(&[0u8; 4]), Err(Error::Truncated));
        let mut b = Header {
            channels: 1,
            sample_rate: 48_000,
            num_samples: 0,
        }
        .to_bytes();
        b[0] = b'X';
        assert!(matches!(Header::parse(&b), Err(Error::InvalidPacket(_))));
    }
}
