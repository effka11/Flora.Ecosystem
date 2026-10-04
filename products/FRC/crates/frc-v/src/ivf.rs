//! Контейнер IVF (как у VP8/VP9/AV1) с FourCC `FRV1` — формат разработки.
//! Продуктовый контейнер (mux с аудио) — совместное решение с аудио-агентом позже.

use std::io::{self, Read, Seek, SeekFrom, Write};

pub const IVF_SIGNATURE: [u8; 4] = *b"DKIF";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IvfHeader {
    pub fourcc: [u8; 4],
    pub width: u16,
    pub height: u16,
    /// Timebase: кадров `num` за `den` секунд не бывает — семантика IVF:
    /// pts измеряется в единицах `num/den` секунд.
    pub timebase_den: u32,
    pub timebase_num: u32,
    pub frame_count: u32,
}

pub struct IvfWriter<W: Write> {
    inner: W,
    frames_written: u32,
}

impl<W: Write> IvfWriter<W> {
    pub fn new(mut inner: W, header: IvfHeader) -> io::Result<Self> {
        let mut h = [0u8; 32];
        h[0..4].copy_from_slice(&IVF_SIGNATURE);
        h[4..6].copy_from_slice(&0u16.to_le_bytes()); // версия
        h[6..8].copy_from_slice(&32u16.to_le_bytes()); // размер заголовка
        h[8..12].copy_from_slice(&header.fourcc);
        h[12..14].copy_from_slice(&header.width.to_le_bytes());
        h[14..16].copy_from_slice(&header.height.to_le_bytes());
        h[16..20].copy_from_slice(&header.timebase_den.to_le_bytes());
        h[20..24].copy_from_slice(&header.timebase_num.to_le_bytes());
        h[24..28].copy_from_slice(&header.frame_count.to_le_bytes());
        inner.write_all(&h)?;
        Ok(IvfWriter {
            inner,
            frames_written: 0,
        })
    }

    pub fn write_frame(&mut self, pts: u64, payload: &[u8]) -> io::Result<()> {
        let size = u32::try_from(payload.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large for ivf"))?;
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

impl<W: Write + Seek> IvfWriter<W> {
    /// Дописывает фактическое число кадров в заголовок (offset 24) и возвращает writer.
    pub fn finalize(mut self) -> io::Result<W> {
        let count = self.frames_written;
        self.inner.seek(SeekFrom::Start(24))?;
        self.inner.write_all(&count.to_le_bytes())?;
        self.inner.seek(SeekFrom::End(0))?;
        Ok(self.inner)
    }
}

pub struct IvfReader<R: Read> {
    inner: R,
    pub header: IvfHeader,
}

impl<R: Read> IvfReader<R> {
    pub fn new(mut inner: R) -> io::Result<Self> {
        let mut h = [0u8; 32];
        inner.read_exact(&mut h)?;
        if h[0..4] != IVF_SIGNATURE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "not an IVF file",
            ));
        }
        let header_size = u16::from_le_bytes([h[6], h[7]]);
        if header_size != 32 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported IVF header size",
            ));
        }
        let header = IvfHeader {
            fourcc: [h[8], h[9], h[10], h[11]],
            width: u16::from_le_bytes([h[12], h[13]]),
            height: u16::from_le_bytes([h[14], h[15]]),
            timebase_den: u32::from_le_bytes([h[16], h[17], h[18], h[19]]),
            timebase_num: u32::from_le_bytes([h[20], h[21], h[22], h[23]]),
            frame_count: u32::from_le_bytes([h[24], h[25], h[26], h[27]]),
        };
        Ok(IvfReader { inner, header })
    }

    /// Читает следующий кадр (pts, payload); `Ok(None)` — конец потока.
    pub fn read_frame(&mut self) -> io::Result<Option<(u64, Vec<u8>)>> {
        let mut size_buf = [0u8; 4];
        match self.inner.read(&mut size_buf)? {
            0 => return Ok(None),
            n if n < 4 => {
                self.inner.read_exact(&mut size_buf[n..])?;
            }
            _ => {}
        }
        let size = u32::from_le_bytes(size_buf) as usize;
        // Защита от абсурдных размеров при битом входе (кадр >256 МиБ невозможен).
        if size > 256 * 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "ivf frame size implausible",
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
        let header = IvfHeader {
            fourcc: crate::FOURCC,
            width: 320,
            height: 180,
            timebase_den: 30,
            timebase_num: 1,
            frame_count: 0,
        };
        let mut w = IvfWriter::new(std::io::Cursor::new(Vec::new()), header).unwrap();
        w.write_frame(0, &[1, 2, 3]).unwrap();
        w.write_frame(1, &[4, 5]).unwrap();
        let bytes = w.finalize().unwrap().into_inner();

        let mut r = IvfReader::new(&bytes[..]).unwrap();
        assert_eq!(
            r.header,
            IvfHeader {
                frame_count: 2,
                ..header
            }
        );
        assert_eq!(r.read_frame().unwrap().unwrap(), (0, vec![1, 2, 3]));
        assert_eq!(r.read_frame().unwrap().unwrap(), (1, vec![4, 5]));
        assert!(r.read_frame().unwrap().is_none());
    }
}
