//! Кадровые буферы: планарный YUV 4:2:0, 8 бит.

/// Одна плоскость изображения (8 бит на отсчёт).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plane {
    data: Vec<u8>,
    width: usize,
    height: usize,
}

impl Plane {
    pub fn new(width: usize, height: usize) -> Self {
        Plane {
            data: vec![128; width * height],
            width,
            height,
        }
    }

    pub fn from_data(data: Vec<u8>, width: usize, height: usize) -> Option<Self> {
        if data.len() != width * height {
            return None;
        }
        Some(Plane {
            data,
            width,
            height,
        })
    }

    #[inline]
    pub fn width(&self) -> usize {
        self.width
    }

    #[inline]
    pub fn height(&self) -> usize {
        self.height
    }

    #[inline]
    pub fn data(&self) -> &[u8] {
        &self.data
    }

    #[inline]
    pub fn data_mut(&mut self) -> &mut [u8] {
        &mut self.data
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.width + x]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, v: u8) {
        self.data[y * self.width + x] = v;
    }

    #[inline]
    pub fn row(&self, y: usize) -> &[u8] {
        &self.data[y * self.width..(y + 1) * self.width]
    }
}

/// Кадр YUV 4:2:0: плоскость Y размера WxH, Cb и Cr — (W/2)x(H/2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub y: Plane,
    pub cb: Plane,
    pub cr: Plane,
}

impl Frame {
    /// Создаёт серый кадр указанного размера (люма). Размеры должны быть чётными.
    pub fn new(width: usize, height: usize) -> Self {
        Frame {
            y: Plane::new(width, height),
            cb: Plane::new(width / 2, height / 2),
            cr: Plane::new(width / 2, height / 2),
        }
    }

    #[inline]
    pub fn width(&self) -> usize {
        self.y.width()
    }

    #[inline]
    pub fn height(&self) -> usize {
        self.y.height()
    }

    #[inline]
    pub fn plane(&self, idx: usize) -> &Plane {
        match idx {
            0 => &self.y,
            1 => &self.cb,
            _ => &self.cr,
        }
    }

    #[inline]
    pub fn plane_mut(&mut self, idx: usize) -> &mut Plane {
        match idx {
            0 => &mut self.y,
            1 => &mut self.cb,
            _ => &mut self.cr,
        }
    }
}
