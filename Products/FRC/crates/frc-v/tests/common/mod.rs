//! Библиотека полигона FRC-V: детерминированные синтетические клипы.
//!
//! Контент вычисляется лениво в «виртуальном мастере» 4-кратного разрешения
//! люмы — движение (панорама, зум, поворот, дрожание) задаётся с точностью
//! ¼ пикселя, той же, что у компенсации движения кодека. Все вычисления
//! целочисленные с фиксированными сидами: клипы бит-в-бит одинаковы на всех
//! платформах, пороги тестов не флапают.
//!
//! Классы контента: плоский, градиент, шахматка, кольца, текст/UI, рельеф
//! (value-noise), плазма (треугольные волны), шум, хрома-шахматка, объекты
//! поверх фона. Монтаж: склейка сцен (cut) и фейд.
#![allow(dead_code)]

use frc_v::{Frame, Plane};

// ---------------------------------------------------------------------------
// Детерминированные источники случайности
// ---------------------------------------------------------------------------

pub struct Lcg(pub u64);

impl Lcg {
    pub fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
}

/// Хэш точки решётки (splitmix64-финализация) — база value-noise и «глифов».
fn lattice_hash(x: u64, y: u64, seed: u64) -> u32 {
    let mut h = seed
        ^ x.wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ y.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 33;
    (h >> 32) as u32
}

/// Value-noise: билинейная интерполяция хэшей решётки с ячейкой 2^k.
/// Вход — координаты мастера (неотрицательные), выход 0..=255.
fn value_noise(x: u64, y: u64, k: u32, seed: u64) -> u32 {
    let cell = 1u64 << k;
    let m = cell - 1;
    let (gx, gy) = (x >> k, y >> k);
    let (fx, fy) = (x & m, y & m);
    let c = |dx: u64, dy: u64| u64::from(lattice_hash(gx + dx, gy + dy, seed) & 0xFF);
    let top = c(0, 0) * (cell - fx) + c(1, 0) * fx;
    let bot = c(0, 1) * (cell - fx) + c(1, 1) * fx;
    ((top * (cell - fy) + bot * fy) >> (2 * k)) as u32
}

/// Треугольная волна с периодом 512: 0..=255..=0.
fn tri(u: i64) -> i64 {
    let p = u.rem_euclid(512);
    if p < 256 { p } else { 511 - p }
}

// ---------------------------------------------------------------------------
// Painter: контент в координатах мастера
// ---------------------------------------------------------------------------

/// Источник контента. `luma` — координаты 4×-мастера люмы (4w × 4h),
/// `chroma` — координаты 4×-мастера хромы (2w × 2h).
pub trait Painter {
    fn luma(&self, x: i64, y: i64) -> u8;
    fn chroma(&self, x: i64, y: i64) -> (u8, u8);
}

/// Однотонная заливка.
pub struct Flat {
    pub y: u8,
    pub cb: u8,
    pub cr: u8,
}

impl Painter for Flat {
    fn luma(&self, _x: i64, _y: i64) -> u8 {
        self.y
    }
    fn chroma(&self, _x: i64, _y: i64) -> (u8, u8) {
        (self.cb, self.cr)
    }
}

/// Плавные линейный + радиальный градиенты (PLANAR/TM-контент, бандинг).
pub struct Gradient {
    pub mw: i64,
    pub mh: i64,
}

impl Painter for Gradient {
    fn luma(&self, x: i64, y: i64) -> u8 {
        let lin = x * 130 / self.mw + y * 60 / self.mh;
        let (dx, dy) = (x - self.mw / 2, y - self.mh / 2);
        let r2 = dx * dx + dy * dy;
        let rad = (r2 * 50 / (self.mw * self.mw / 4 + self.mh * self.mh / 4 + 1)).min(50);
        (30 + lin + rad).clamp(0, 255) as u8
    }
    fn chroma(&self, x: i64, y: i64) -> (u8, u8) {
        let cb = 90 + x * 70 / (self.mw / 2).max(1);
        let cr = 170 - y * 70 / (self.mh / 2).max(1);
        (cb.clamp(0, 255) as u8, cr.clamp(0, 255) as u8)
    }
}

/// Контрастная шахматка (жёсткие рёбра, направленные режимы, деблокинг).
pub struct Checker {
    /// Сторона клетки в ¼-пикселях люмы.
    pub cell_q: i64,
}

impl Painter for Checker {
    fn luma(&self, x: i64, y: i64) -> u8 {
        let on = ((x / self.cell_q) + (y / self.cell_q)) & 1 == 0;
        if on { 205 } else { 50 }
    }
    fn chroma(&self, x: i64, y: i64) -> (u8, u8) {
        let on = ((2 * x / self.cell_q) + (2 * y / self.cell_q)) & 1 == 0;
        if on { (118, 138) } else { (138, 118) }
    }
}

/// Концентрические кольца с утончением к краю (кривые рёбра, зум-контент).
pub struct Rings {
    pub cx: i64,
    pub cy: i64,
}

impl Painter for Rings {
    fn luma(&self, x: i64, y: i64) -> u8 {
        let (dx, dy) = (x - self.cx, y - self.cy);
        let r2 = (dx * dx + dy * dy) >> 6;
        let band = r2 / 220;
        let base = if band % 2 == 0 { 185 } else { 65 };
        (base - (r2 / 160).min(35)).clamp(0, 255) as u8
    }
    fn chroma(&self, x: i64, y: i64) -> (u8, u8) {
        let (dx, dy) = (x - self.cx / 2, y - self.cy / 2);
        let r2 = (dx * dx + dy * dy) >> 5;
        if (r2 / 240) % 2 == 0 {
            (112, 150)
        } else {
            (150, 108)
        }
    }
}

/// Псевдотекст/UI: тёмные «глифы» из хэш-битов на светлом фоне (screen content).
pub struct TextLike {
    pub seed: u64,
}

impl TextLike {
    /// Ячейка глифа 48×64 q (12×16 пикселей люмы), поле 1 субклетки по краям,
    /// глиф — битовая маска 4×5 субклеток по 8×8 q.
    fn glyph_on(&self, x: i64, y: i64) -> bool {
        let (cx, cy) = (x.div_euclid(48), y.div_euclid(64));
        let (ix, iy) = (x.rem_euclid(48), y.rem_euclid(64));
        // Межстрочный интервал и поля ячейки.
        if !(8..40).contains(&ix) || !(8..56).contains(&iy) {
            return false;
        }
        let bits = lattice_hash(cx as u64, cy as u64, self.seed);
        // Пустая «пробельная» ячейка каждая ~4-я.
        if bits & 0xC000_0000 == 0 {
            return false;
        }
        let (sx, sy) = ((ix - 8) / 8, (iy - 8) / 8); // 4×6 субклеток
        bits >> (sy * 4 + sx) & 1 == 1
    }
}

impl Painter for TextLike {
    fn luma(&self, x: i64, y: i64) -> u8 {
        if self.glyph_on(x, y) { 38 } else { 232 }
    }
    fn chroma(&self, x: i64, y: i64) -> (u8, u8) {
        if self.glyph_on(2 * x, 2 * y) {
            (135, 120)
        } else {
            (124, 130)
        }
    }
}

/// «Рельеф»: двухоктавный value-noise + пологий градиент (естественная текстура).
pub struct Terrain {
    pub seed: u64,
}

impl Painter for Terrain {
    fn luma(&self, x: i64, y: i64) -> u8 {
        let (ux, uy) = (x.max(0) as u64, y.max(0) as u64);
        let coarse = value_noise(ux, uy, 8, self.seed); // ячейка 64 q = 16 px
        let fine = value_noise(ux, uy, 6, self.seed ^ 0xA5A5); // 16 q = 4 px
        let v = i64::from((coarse * 5 + fine * 3) / 8);
        (40 + v * 170 / 255 + (x % 512) / 32).clamp(0, 255) as u8
    }
    fn chroma(&self, x: i64, y: i64) -> (u8, u8) {
        let (ux, uy) = (x.max(0) as u64, y.max(0) as u64);
        let cb = 104 + value_noise(ux, uy, 7, self.seed ^ 0x0B0B) * 44 / 255;
        let cr = 106 + value_noise(ux, uy, 7, self.seed ^ 0x0C0C) * 44 / 255;
        (cb as u8, cr as u8)
    }
}

/// Сумма треугольных волн — гладкий «органический» паттерн (плазма).
pub struct Plasma;

impl Painter for Plasma {
    fn luma(&self, x: i64, y: i64) -> u8 {
        let v = tri(x * 3 / 2 + y / 2) + tri(x / 2 - y + 431) + tri(x + y * 2 + 977);
        (35 + v * 185 / (3 * 255)) as u8
    }
    fn chroma(&self, x: i64, y: i64) -> (u8, u8) {
        let cb = 100 + tri(x - y + 200) * 56 / 255;
        let cr = 100 + tri(x + y + 700) * 56 / 255;
        (cb as u8, cr as u8)
    }
}

/// Пиксельный шум мастера (худший случай предсказания, потолок энтропии).
pub struct NoiseP {
    pub seed: u64,
    /// Амплитуда: люма 128 ± amp.
    pub amp: u32,
}

impl Painter for NoiseP {
    fn luma(&self, x: i64, y: i64) -> u8 {
        let h = lattice_hash(x.max(0) as u64, y.max(0) as u64, self.seed);
        (128 - self.amp as i64 + i64::from(h % (2 * self.amp + 1))).clamp(0, 255) as u8
    }
    fn chroma(&self, x: i64, y: i64) -> (u8, u8) {
        let a = self.amp / 2 + 1;
        let h1 = lattice_hash(x.max(0) as u64, y.max(0) as u64, self.seed ^ 0x11);
        let h2 = lattice_hash(x.max(0) as u64, y.max(0) as u64, self.seed ^ 0x22);
        (
            (128 - a as i64 + i64::from(h1 % (2 * a + 1))).clamp(0, 255) as u8,
            (128 - a as i64 + i64::from(h2 % (2 * a + 1))).clamp(0, 255) as u8,
        )
    }
}

/// Спокойная люма + контрастная хрома-шахматка (изоляция качества хромы).
pub struct ChromaCheck {
    pub cell_q: i64,
}

impl Painter for ChromaCheck {
    fn luma(&self, x: i64, y: i64) -> u8 {
        (118 + (x + y) / 96).clamp(0, 255) as u8
    }
    fn chroma(&self, x: i64, y: i64) -> (u8, u8) {
        let c = self.cell_q / 2; // хрома-мастер вдвое мельче люма-мастера
        let on = ((x / c) + (y / c)) & 1 == 0;
        if on { (86, 182) } else { (176, 78) }
    }
}

// ---------------------------------------------------------------------------
// Движение и рендер
// ---------------------------------------------------------------------------

/// Движение мастера между кадрами. Все скорости — в ¼-пикселях люмы за кадр.
#[derive(Clone, Copy)]
pub enum Motion {
    Static,
    Pan { vx_q: i64, vy_q: i64 },
    /// Зум к центру: масштаб s(t) = 1 − t·rate/65536 (rate > 0 — наезд).
    Zoom { rate_q16: i64 },
    /// Поворот вокруг центра, рад/кадр в Q16.
    Rotate { rate_q16: i64 },
    /// Дрожание камеры: случайные (детерминированные) сдвиги ±amp_q.
    Jitter { seed: u64, amp_q: i64 },
}

/// (sin, cos) угла в Q16 (ряд Тейлора; точен при |a| ≲ 0.6 рад).
fn sincos_q16(a: i64) -> (i64, i64) {
    let a2 = (a * a) >> 16;
    let a3 = (a2 * a) >> 16;
    let a4 = (a2 * a2) >> 16;
    (a - a3 / 6, 65536 - a2 / 2 + a4 / 24)
}

/// Рендер кадра `t`: для каждого пикселя позиция в мастере пропускается через
/// `map` (аффинное движение) и клампится к границам мастера.
fn render_frame<P: Painter>(p: &P, w: usize, h: usize, map: impl Fn(i64, i64) -> (i64, i64)) -> Frame {
    let (mw, mh) = ((w * 4) as i64, (h * 4) as i64);
    let mut f = Frame::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (sx, sy) = map((x as i64) * 4, (y as i64) * 4);
            let (sx, sy) = (sx.clamp(0, mw - 1), sy.clamp(0, mh - 1));
            f.y.set(x, y, p.luma(sx, sy));
        }
    }
    let (cw, ch) = (w / 2, h / 2);
    let (cmw, cmh) = ((cw * 4) as i64, (ch * 4) as i64);
    for cy in 0..ch {
        for cx in 0..cw {
            let (sx, sy) = map((cx as i64) * 8, (cy as i64) * 8);
            let (sx, sy) = ((sx / 2).clamp(0, cmw - 1), (sy / 2).clamp(0, cmh - 1));
            let (cb, cr) = p.chroma(sx, sy);
            f.cb.set(cx, cy, cb);
            f.cr.set(cx, cy, cr);
        }
    }
    f
}

/// Клип из painter'а и закона движения.
pub fn make_clip<P: Painter>(p: &P, w: usize, h: usize, frames: usize, motion: Motion) -> Vec<Frame> {
    let (cx, cy) = ((w * 2) as i64, (h * 2) as i64); // центр мастера
    let jitter: Vec<(i64, i64)> = if let Motion::Jitter { seed, amp_q } = motion {
        let mut rng = Lcg(seed);
        (0..frames)
            .map(|_| {
                let side = 2 * amp_q + 1;
                (
                    i64::from(rng.next()) % side - amp_q,
                    i64::from(rng.next()) % side - amp_q,
                )
            })
            .collect()
    } else {
        Vec::new()
    };
    (0..frames)
        .map(|t| {
            let ti = t as i64;
            match motion {
                Motion::Static => render_frame(p, w, h, |mx, my| (mx, my)),
                Motion::Pan { vx_q, vy_q } => {
                    render_frame(p, w, h, |mx, my| (mx + ti * vx_q, my + ti * vy_q))
                }
                Motion::Zoom { rate_q16 } => {
                    let s = 65536 - ti * rate_q16;
                    render_frame(p, w, h, |mx, my| {
                        (cx + (((mx - cx) * s) >> 16), cy + (((my - cy) * s) >> 16))
                    })
                }
                Motion::Rotate { rate_q16 } => {
                    let (sin, cos) = sincos_q16(ti * rate_q16);
                    render_frame(p, w, h, |mx, my| {
                        let (dx, dy) = (mx - cx, my - cy);
                        (
                            cx + ((dx * cos - dy * sin) >> 16),
                            cy + ((dx * sin + dy * cos) >> 16),
                        )
                    })
                }
                Motion::Jitter { .. } => {
                    let (jx, jy) = jitter[t];
                    render_frame(p, w, h, |mx, my| (mx + jx, my + jy))
                }
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Объекты, монтаж
// ---------------------------------------------------------------------------

/// Прямоугольный объект в координатах мастера (¼-пиксели люмы).
#[derive(Clone, Copy)]
pub struct MovingObject {
    pub x0_q: i64,
    pub y0_q: i64,
    pub vx_q: i64,
    pub vy_q: i64,
    pub w_q: i64,
    pub h_q: i64,
    pub luma: u8,
    pub cb: u8,
    pub cr: u8,
}

struct ObjectScene<'a, P: Painter> {
    bg: &'a P,
    objs: &'a [MovingObject],
    t: i64,
}

impl<P: Painter> ObjectScene<'_, P> {
    fn hit(&self, x: i64, y: i64) -> Option<&MovingObject> {
        self.objs.iter().find(|o| {
            let ox = o.x0_q + self.t * o.vx_q;
            let oy = o.y0_q + self.t * o.vy_q;
            (ox..ox + o.w_q).contains(&x) && (oy..oy + o.h_q).contains(&y)
        })
    }
}

impl<P: Painter> Painter for ObjectScene<'_, P> {
    fn luma(&self, x: i64, y: i64) -> u8 {
        match self.hit(x, y) {
            // Рамка 8 q (2 px) темнее тела — объекту нужна внутренняя структура.
            Some(o) => {
                let ox = o.x0_q + self.t * o.vx_q;
                let oy = o.y0_q + self.t * o.vy_q;
                let edge = (x - ox).min(ox + o.w_q - 1 - x).min(y - oy).min(oy + o.h_q - 1 - y);
                if edge < 8 {
                    o.luma / 2
                } else {
                    o.luma
                }
            }
            None => self.bg.luma(x, y),
        }
    }
    fn chroma(&self, x: i64, y: i64) -> (u8, u8) {
        // Хрома-мастер вдвое мельче: объект в (2x, 2y) люма-координатах.
        match self.hit(2 * x, 2 * y) {
            Some(o) => (o.cb, o.cr),
            None => self.bg.chroma(x, y),
        }
    }
}

/// Клип: статичный фон + движущиеся объекты (окклюзия/открытие фона).
pub fn make_object_clip<P: Painter>(
    bg: &P,
    objs: &[MovingObject],
    w: usize,
    h: usize,
    frames: usize,
) -> Vec<Frame> {
    (0..frames)
        .map(|t| {
            let scene = ObjectScene {
                bg,
                objs,
                t: t as i64,
            };
            render_frame(&scene, w, h, |mx, my| (mx, my))
        })
        .collect()
}

/// Склейка сцен (жёсткий cut).
pub fn concat(mut a: Vec<Frame>, b: Vec<Frame>) -> Vec<Frame> {
    a.extend(b);
    a
}

/// Фейд яркости: кадр t получает люму + t·delta (кламп).
pub fn apply_fade(frames: &mut [Frame], delta_per_frame: i32) {
    for (t, f) in frames.iter_mut().enumerate() {
        let d = t as i32 * delta_per_frame;
        for v in f.y.data_mut() {
            *v = (i32::from(*v) + d).clamp(0, 255) as u8;
        }
    }
}

// ---------------------------------------------------------------------------
// Утилиты проверок
// ---------------------------------------------------------------------------

/// FNV-1a 64 всех плоскостей кадра (пины декодера).
pub fn frame_fnv64(f: &Frame) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for plane in [f.y.data(), f.cb.data(), f.cr.data()] {
        for &b in plane {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

/// Средняя люма плоскости (санити-проверки генераторов).
pub fn plane_mean(p: &Plane) -> u32 {
    (p.data().iter().map(|&v| u32::from(v)).sum::<u32>() / p.data().len() as u32).min(255)
}
