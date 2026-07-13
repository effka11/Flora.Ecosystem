//! Минимальный YUV4MPEG2 (y4m) reader/writer: обмен сырыми кадрами с ffmpeg и тестами.
//! Поддерживается только 4:2:0 8 бит (C420 / C420jpeg / C420mpeg2 / C420paldv).

use crate::frame::{Frame, Plane};
use std::io::{self, Read, Write};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoParams {
    pub width: usize,
    pub height: usize,
    /// Частота кадров: числитель/знаменатель.
    pub fps_num: u32,
    pub fps_den: u32,
}

pub struct Y4mReader<R: Read> {
    inner: R,
    pub params: VideoParams,
}

fn read_line<R: Read>(r: &mut R, max: usize) -> io::Result<String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = r.read(&mut byte)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "eof in y4m header"));
        }
        if byte[0] == b'\n' {
            break;
        }
        if buf.len() >= max {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "y4m header too long"));
        }
        buf.push(byte[0]);
    }
    String::from_utf8(buf).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "y4m header not utf8"))
}

impl<R: Read> Y4mReader<R> {
    pub fn new(mut inner: R) -> io::Result<Self> {
        let header = read_line(&mut inner, 512)?;
        let mut parts = header.split(' ');
        if parts.next() != Some("YUV4MPEG2") {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "not a y4m stream"));
        }
        let (mut w, mut h, mut fn_, mut fd) = (0usize, 0usize, 25u32, 1u32);
        for p in parts {
            let (tag, val) = p.split_at(1);
            match tag {
                "W" => w = val.parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad W"))?,
                "H" => h = val.parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad H"))?,
                "F" => {
                    let (n, d) = val.split_once(':').ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad F"))?;
                    fn_ = n.parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad F num"))?;
                    fd = d.parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad F den"))?;
                }
                "C" => {
                    if !matches!(val, "420" | "420jpeg" | "420mpeg2" | "420paldv") {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "only 4:2:0 8-bit y4m is supported",
                        ));
                    }
                }
                _ => {} // I, A, X — игнорируем
            }
        }
        if w == 0 || h == 0 || w % 2 != 0 || h % 2 != 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad y4m dimensions"));
        }
        Ok(Y4mReader { inner, params: VideoParams { width: w, height: h, fps_num: fn_, fps_den: fd } })
    }

    /// Читает следующий кадр; `Ok(None)` — конец потока.
    pub fn read_frame(&mut self) -> io::Result<Option<Frame>> {
        let mut first = [0u8; 1];
        match self.inner.read(&mut first)? {
            0 => return Ok(None),
            _ => {
                if first[0] != b'F' {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "bad FRAME marker"));
                }
            }
        }
        // Дочитываем строку "RAME...\n"
        let rest = read_line(&mut self.inner, 512)?;
        if !rest.starts_with("RAME") {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad FRAME marker"));
        }
        let (w, h) = (self.params.width, self.params.height);
        let mut read_plane = |pw: usize, ph: usize| -> io::Result<Plane> {
            let mut data = vec![0u8; pw * ph];
            self.inner.read_exact(&mut data)?;
            Ok(Plane::from_data(data, pw, ph).expect("size checked"))
        };
        let y = read_plane(w, h)?;
        let cb = read_plane(w / 2, h / 2)?;
        let cr = read_plane(w / 2, h / 2)?;
        Ok(Some(Frame { y, cb, cr }))
    }
}

pub struct Y4mWriter<W: Write> {
    inner: W,
}

impl<W: Write> Y4mWriter<W> {
    pub fn new(mut inner: W, params: VideoParams) -> io::Result<Self> {
        writeln!(
            inner,
            "YUV4MPEG2 W{} H{} F{}:{} Ip A1:1 C420mpeg2",
            params.width, params.height, params.fps_num, params.fps_den
        )?;
        Ok(Y4mWriter { inner })
    }

    pub fn write_frame(&mut self, frame: &Frame) -> io::Result<()> {
        self.inner.write_all(b"FRAME\n")?;
        self.inner.write_all(frame.y.data())?;
        self.inner.write_all(frame.cb.data())?;
        self.inner.write_all(frame.cr.data())?;
        Ok(())
    }

    pub fn into_inner(self) -> W {
        self.inner
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let mut f = Frame::new(16, 8);
        for (i, v) in f.y.data_mut().iter_mut().enumerate() {
            *v = (i * 7 % 256) as u8;
        }
        let params = VideoParams { width: 16, height: 8, fps_num: 30, fps_den: 1 };
        let mut w = Y4mWriter::new(Vec::new(), params).unwrap();
        w.write_frame(&f).unwrap();
        w.write_frame(&f).unwrap();
        let bytes = w.into_inner();

        let mut r = Y4mReader::new(&bytes[..]).unwrap();
        assert_eq!(r.params, params);
        assert_eq!(r.read_frame().unwrap().unwrap(), f);
        assert_eq!(r.read_frame().unwrap().unwrap(), f);
        assert!(r.read_frame().unwrap().is_none());
    }
}
