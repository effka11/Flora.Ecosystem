//! Нативный элементарный контейнер FRC-V (`.frv`, magic `8F 46 52 56`).

//!

//! Один видеопоток FRV1; структура записей идентична IVF (length-prefixed

//! кадры с pts) — стриминг и конкатенация тривиальны. Продуктовый A/V-mux

//! с FRC-A — отдельный формат, совместное решение с аудио (см. `Documents/codecs/CODECS.md`).

//!

//! Заголовок (32 байта, little-endian):

//! ```text

//! 0   magic       8F 46 52 56 ("\x8F" "FRV")

//! 4   version     u8  = 1

//! 5   flags       u8  = 0 (зарезервировано)

//! 6   width       u16

//! 8   height      u16

//! 10  fps_num     u32   (кадров в секунду = fps_num / fps_den)

//! 14  fps_den     u32

//! 18  frame_count u32   (0 = неизвестно / поток)

//! 22  reserved    [10]  = 0

//! ```

//! Кадр: `size u32, pts u64, payload[size]`.

use std::io::{self, Read, Seek, SeekFrom, Write};

pub const FRC_V_MAGIC: [u8; 4] = [0x8F, b'F', b'R', b'V'];

pub const CONTAINER_VERSION: u8 = 1;

const HEADER_LEN: usize = 32;

const FRAME_COUNT_OFFSET: u64 = 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]

pub struct FrcVHeader {
    pub width: u16,

    pub height: u16,

    pub fps_num: u32,

    pub fps_den: u32,

    pub frame_count: u32,
}

pub struct FrcVWriter<W: Write> {
    inner: W,

    frames_written: u32,
}

impl<W: Write> FrcVWriter<W> {
    pub fn new(mut inner: W, header: FrcVHeader) -> io::Result<Self> {
        let mut h = [0u8; HEADER_LEN];

        h[0..4].copy_from_slice(&FRC_V_MAGIC);

        h[4] = CONTAINER_VERSION;

        h[5] = 0;

        h[6..8].copy_from_slice(&header.width.to_le_bytes());

        h[8..10].copy_from_slice(&header.height.to_le_bytes());

        h[10..14].copy_from_slice(&header.fps_num.to_le_bytes());

        h[14..18].copy_from_slice(&header.fps_den.to_le_bytes());

        h[18..22].copy_from_slice(&header.frame_count.to_le_bytes());

        inner.write_all(&h)?;

        Ok(FrcVWriter {
            inner,

            frames_written: 0,
        })
    }

    pub fn write_frame(&mut self, pts: u64, payload: &[u8]) -> io::Result<()> {
        let size = u32::try_from(payload.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;

        self.inner.write_all(&size.to_le_bytes())?;

        self.inner.write_all(&pts.to_le_bytes())?;

        self.inner.write_all(payload)?;

        self.frames_written += 1;

        Ok(())
    }

    pub fn frames_written(&self) -> u32 {
        self.frames_written
    }

    pub fn into_inner(self) -> W {
        self.inner
    }
}

impl<W: Write + Seek> FrcVWriter<W> {
    /// Дописывает фактическое число кадров в заголовок и возвращает writer.
    pub fn finalize(mut self) -> io::Result<W> {
        let count = self.frames_written;

        self.inner.seek(SeekFrom::Start(FRAME_COUNT_OFFSET))?;

        self.inner.write_all(&count.to_le_bytes())?;

        self.inner.seek(SeekFrom::End(0))?;

        Ok(self.inner)
    }
}

pub struct FrcVReader<R: Read> {
    inner: R,

    pub header: FrcVHeader,
}

impl<R: Read> FrcVReader<R> {
    pub fn new(mut inner: R) -> io::Result<Self> {
        let mut h = [0u8; HEADER_LEN];

        inner.read_exact(&mut h)?;

        if h[0..4] != FRC_V_MAGIC {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "not an FRC-V file",
            ));
        }

        if h[4] != CONTAINER_VERSION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported FRC-V container version",
            ));
        }

        let header = FrcVHeader {
            width: u16::from_le_bytes([h[6], h[7]]),

            height: u16::from_le_bytes([h[8], h[9]]),

            fps_num: u32::from_le_bytes([h[10], h[11], h[12], h[13]]),

            fps_den: u32::from_le_bytes([h[14], h[15], h[16], h[17]]),

            frame_count: u32::from_le_bytes([h[18], h[19], h[20], h[21]]),
        };

        Ok(FrcVReader { inner, header })
    }

    /// Читает следующий кадр (pts, payload); `Ok(None)` — конец потока.
    pub fn read_frame(&mut self) -> io::Result<Option<(u64, Vec<u8>)>> {
        let mut size_buf = [0u8; 4];

        match self.inner.read(&mut size_buf)? {
            0 => return Ok(None),

            n if n < 4 => self.inner.read_exact(&mut size_buf[n..])?,

            _ => {}
        }

        let size = u32::from_le_bytes(size_buf) as usize;

        if size > 256 * 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "frame size implausible",
            ));
        }

        let mut pts_buf = [0u8; 8];

        self.inner.read_exact(&mut pts_buf)?;

        let mut payload = vec![0u8; size];

        self.inner.read_exact(&mut payload)?;

        Ok(Some((u64::from_le_bytes(pts_buf), payload)))
    }
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]

    fn roundtrip_with_finalize() {
        let header = FrcVHeader {
            width: 640,

            height: 360,

            fps_num: 30,

            fps_den: 1,

            frame_count: 0,
        };

        let mut w = FrcVWriter::new(std::io::Cursor::new(Vec::new()), header).unwrap();

        w.write_frame(0, &[7, 8, 9]).unwrap();

        w.write_frame(1, &[1]).unwrap();

        let bytes = w.finalize().unwrap().into_inner();

        assert_eq!(&bytes[0..4], &FRC_V_MAGIC);

        let mut r = FrcVReader::new(&bytes[..]).unwrap();

        assert_eq!(
            r.header,
            FrcVHeader {
                frame_count: 2,

                ..header
            }
        );

        assert_eq!(r.read_frame().unwrap().unwrap(), (0, vec![7, 8, 9]));

        assert_eq!(r.read_frame().unwrap().unwrap(), (1, vec![1]));

        assert!(r.read_frame().unwrap().is_none());
    }

    #[test]

    fn rejects_foreign_data() {
        assert!(FrcVReader::new(&b"DKIF\0\0 \0FRV1"[..]).is_err());

        assert!(FrcVReader::new(&[0u8; 8][..]).is_err());
    }
}
