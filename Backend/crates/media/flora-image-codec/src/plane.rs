//! Плоскость отсчётов (компонента цвета) в i16 и прямоугольные регионы-тайлы.

/// Полноразмерная плоскость одной компоненты.
pub struct Plane {
    pub w: usize,
    pub h: usize,
    pub data: Vec<i16>,
}

impl Plane {
    pub fn new(w: usize, h: usize) -> Self {
        Self { w, h, data: vec![0; w * h] }
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize) -> i16 {
        self.data[y * self.w + x]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, v: i16) {
        self.data[y * self.w + x] = v;
    }

    /// Копирует прямоугольник `w x h` с позиции `(x0, y0)` в отдельный буфер.
    pub fn extract(&self, x0: usize, y0: usize, w: usize, h: usize) -> Vec<i16> {
        let mut out = Vec::with_capacity(w * h);
        for y in 0..h {
            let row = (y0 + y) * self.w + x0;
            out.extend_from_slice(&self.data[row..row + w]);
        }
        out
    }

    /// Записывает буфер `w x h` в прямоугольник с позиции `(x0, y0)`.
    pub fn insert(&mut self, x0: usize, y0: usize, w: usize, h: usize, buf: &[i16]) {
        debug_assert_eq!(buf.len(), w * h);
        for y in 0..h {
            let row = (y0 + y) * self.w + x0;
            self.data[row..row + w].copy_from_slice(&buf[y * w..(y + 1) * w]);
        }
    }
}

/// Диапазон допустимых значений плоскости; декодер клампит реконструкцию в него.
#[derive(Clone, Copy)]
pub struct SampleRange {
    pub lo: i32,
    pub hi: i32,
    /// Значение виртуальных соседей за границей изображения.
    pub mid: i32,
}

/// Яркость и альфа: 0..=255, виртуальный сосед 128.
pub const RANGE_LUMA: SampleRange = SampleRange { lo: 0, hi: 255, mid: 128 };
/// Обратимые цветоразности YCoCg-R: -255..=255, виртуальный сосед 0.
pub const RANGE_CHROMA_LOSSLESS: SampleRange = SampleRange { lo: -255, hi: 255, mid: 0 };
