//! Заголовок кадра FVC1 (байтовый, до арифметического потока).

use crate::{BITSTREAM_VERSION, Error, MAX_DIMENSION};

pub const FRAME_HEADER_LEN: usize = 7;

const FLAG_KEYFRAME: u8 = 0b0000_0001;
const FLAG_LOOP_FILTER: u8 = 0b0000_0010;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub keyframe: bool,
    pub loop_filter: bool,
    pub qp: u8,
    pub width: u32,
    pub height: u32,
}

impl FrameHeader {
    pub fn write(&self, out: &mut Vec<u8>) {
        let mut flags = 0u8;
        if self.keyframe {
            flags |= FLAG_KEYFRAME;
        }
        if self.loop_filter {
            flags |= FLAG_LOOP_FILTER;
        }
        out.push(BITSTREAM_VERSION);
        out.push(flags);
        out.push(self.qp);
        let w = (self.width - 1) as u16;
        let h = (self.height - 1) as u16;
        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());
    }

    /// Разбирает заголовок; возвращает заголовок и срез арифметического потока.
    pub fn parse(data: &[u8]) -> Result<(FrameHeader, &[u8]), Error> {
        if data.len() < FRAME_HEADER_LEN {
            return Err(Error::InvalidBitstream("frame too short"));
        }
        if data[0] != BITSTREAM_VERSION {
            return Err(Error::InvalidBitstream("unsupported bitstream version"));
        }
        let flags = data[1];
        let qp = data[2];
        if qp > 63 {
            return Err(Error::InvalidBitstream("qp out of range"));
        }
        let width = u32::from(u16::from_le_bytes([data[3], data[4]])) + 1;
        let height = u32::from(u16::from_le_bytes([data[5], data[6]])) + 1;
        let header = FrameHeader {
            keyframe: flags & FLAG_KEYFRAME != 0,
            loop_filter: flags & FLAG_LOOP_FILTER != 0,
            qp,
            width,
            height,
        };
        if !header.keyframe {
            return Err(Error::InvalidBitstream("inter frames are not defined in v0.1"));
        }
        if width > MAX_DIMENSION || height > MAX_DIMENSION || width % 8 != 0 || height % 8 != 0 {
            return Err(Error::InvalidBitstream("invalid dimensions"));
        }
        Ok((header, &data[FRAME_HEADER_LEN..]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let h = FrameHeader { keyframe: true, loop_filter: true, qp: 37, width: 1280, height: 720 };
        let mut buf = Vec::new();
        h.write(&mut buf);
        buf.extend_from_slice(&[9, 9, 9]);
        let (parsed, rest) = FrameHeader::parse(&buf).unwrap();
        assert_eq!(parsed, h);
        assert_eq!(rest, &[9, 9, 9]);
    }

    #[test]
    fn rejects_garbage() {
        assert!(FrameHeader::parse(&[]).is_err());
        assert!(FrameHeader::parse(&[2, 1, 10, 0, 0, 0, 0]).is_err()); // версия
        assert!(FrameHeader::parse(&[1, 0, 10, 7, 0, 7, 0]).is_err()); // не keyframe
        assert!(FrameHeader::parse(&[1, 1, 99, 7, 0, 7, 0]).is_err()); // qp
        assert!(FrameHeader::parse(&[1, 1, 10, 2, 0, 7, 0]).is_err()); // ширина не кратна 8
    }
}
