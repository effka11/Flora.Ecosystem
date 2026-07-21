//! Корпус полигона: детерминированная целочисленная синтетика + эталонные
//! клипы xiph/derf.
//!
//! Синтетика рендерится в «виртуальном мастере» 4-кратного разрешения люмы
//! (движение с точностью ¼ пикселя — та же сетка, что у MC кодеков) и
//! кэшируется в y4m: бит-в-бит одинакова на всех платформах, прогоны
//! воспроизводимы. Классы: натуральная текстура (fractal value-noise),
//! органика (плазма), screen content (глифы/панели), объекты с окклюзией,
//! хрома-нагрузка, темпоральное зерно, монтаж со склейками, масштаб 720p.

use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter};
use std::path::{Path, PathBuf};

use frc_v::Frame;
#[cfg(test)]
use frc_v::Plane;
use frc_v::y4m::{Y4mReader, Y4mWriter};

/// Версия генераторов: меняется при любой правке синтетики (инвалидация кэша).
pub const SYNTH_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Целочисленные примитивы
// ---------------------------------------------------------------------------

/// Хэш точки решётки (финализация splitmix64).
fn lattice_hash(x: u64, y: u64, seed: u64) -> u32 {
    let mut h =
        seed ^ x.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ y.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 33;
    (h >> 32) as u32
}

/// Value-noise: билинейная интерполяция хэшей решётки с ячейкой 2^k, 0..=255.
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

/// Четырёхоктавный fractal value-noise, 0..=255.
fn fractal_noise(x: u64, y: u64, seed: u64) -> u32 {
    let o0 = value_noise(x, y, 9, seed);
    let o1 = value_noise(x, y, 8, seed ^ 0x51D3);
    let o2 = value_noise(x, y, 7, seed ^ 0xA7E9);
    let o3 = value_noise(x, y, 6, seed ^ 0x3C11);
    (o0 * 6 + o1 * 4 + o2 * 3 + o3 * 2) / 15
}

/// Треугольная волна с периодом 512: 0..=255..=0.
fn tri(u: i64) -> i64 {
    let p = u.rem_euclid(512);
    if p < 256 { p } else { 511 - p }
}

/// (sin, cos) угла в Q16 (ряд Тейлора; точен при |a| ≲ 0.6 рад).
fn sincos_q16(a: i64) -> (i64, i64) {
    let a2 = (a * a) >> 16;
    let a3 = (a2 * a) >> 16;
    let a4 = (a2 * a2) >> 16;
    (a - a3 / 6, 65536 - a2 / 2 + a4 / 24)
}

// ---------------------------------------------------------------------------
// Painter'ы (контент в координатах мастера, ¼-пиксели люмы)
// ---------------------------------------------------------------------------

/// Источник контента: `luma` — координаты 4×-мастера люмы, `chroma` —
/// координаты 4×-мастера хромы (вдвое мельче). `t` — номер кадра
/// (темпоральные эффекты: зерно, анимация объектов).
trait Painter {
    fn luma(&self, t: i64, x: i64, y: i64) -> u8;
    fn chroma(&self, t: i64, x: i64, y: i64) -> (u8, u8);
}

/// Натуральная текстура: fractal noise + пологий вертикальный свет.
struct Landscape {
    seed: u64,
}

impl Painter for Landscape {
    fn luma(&self, _t: i64, x: i64, y: i64) -> u8 {
        let (ux, uy) = (x.max(0) as u64, y.max(0) as u64);
        let n = i64::from(fractal_noise(ux, uy, self.seed));
        (26 + n * 175 / 255 + y / 96).clamp(0, 255) as u8
    }
    fn chroma(&self, _t: i64, x: i64, y: i64) -> (u8, u8) {
        let (ux, uy) = (x.max(0) as u64, y.max(0) as u64);
        let cb = 106 + value_noise(ux, uy, 8, self.seed ^ 0x0B0B) * 40 / 255;
        let cr = 108 + value_noise(ux, uy, 8, self.seed ^ 0x0C0C) * 40 / 255;
        (cb as u8, cr as u8)
    }
}

/// Гладкая органика: сумма треугольных волн + радиальная компонента.
struct Plasma;

impl Painter for Plasma {
    fn luma(&self, _t: i64, x: i64, y: i64) -> u8 {
        let r = ((x - 700) * (x - 700) + (y - 500) * (y - 500)) >> 9;
        let v = tri(x * 5 / 4 + y / 3) + tri(x / 2 - y * 2 + 313) + tri(r + 811);
        (30 + v * 190 / (3 * 255)) as u8
    }
    fn chroma(&self, _t: i64, x: i64, y: i64) -> (u8, u8) {
        let cb = 98 + tri(x - y + 144) * 60 / 255;
        let cr = 102 + tri(x + y / 2 + 655) * 56 / 255;
        (cb as u8, cr as u8)
    }
}

/// Screen content: «приложение» — шапка, разделители строк, псевдотекст
/// из хэш-глифов, квадратные «иконки» слева.
struct UiText {
    seed: u64,
}

impl UiText {
    /// Глиф в ячейке 40×56 q (10×14 px): маска 4×5 субклеток по 8×8 q.
    fn glyph_on(&self, x: i64, y: i64) -> bool {
        let (cx, cy) = (x.div_euclid(40), y.div_euclid(56));
        let (ix, iy) = (x.rem_euclid(40), y.rem_euclid(56));
        if !(4..36).contains(&ix) || !(8..48).contains(&iy) {
            return false;
        }
        let bits = lattice_hash(cx as u64, cy as u64, self.seed);
        // «Пробел» примерно в четверти ячеек — рваные строки, как в тексте.
        if bits & 0xC000_0000 == 0 {
            return false;
        }
        let (sx, sy) = ((ix - 4) / 8, (iy - 8) / 8);
        bits >> (sy * 4 + sx) & 1 == 1
    }

    /// Иконка: квадрат 48×48 q в начале каждой «строки списка» высотой 128 q.
    fn icon_on(&self, x: i64, y: i64) -> bool {
        let row = y.div_euclid(128);
        let iy = y.rem_euclid(128);
        (16..64).contains(&x) && (40..88).contains(&iy) && row.rem_euclid(2) == 0
    }
}

impl Painter for UiText {
    fn luma(&self, _t: i64, x: i64, y: i64) -> u8 {
        // Шапка приложения.
        if y < 96 {
            return if self.glyph_on(x - 32, y - 20) {
                235
            } else {
                52
            };
        }
        // Тонкий разделитель каждой строки списка.
        if y.rem_euclid(128) < 4 {
            return 196;
        }
        if self.icon_on(x, y) {
            return 120;
        }
        // Текст в две колонки с отступом под иконку.
        if x > 96 && self.glyph_on(x - 96, y - 10) {
            36
        } else {
            243
        }
    }
    fn chroma(&self, _t: i64, x: i64, y: i64) -> (u8, u8) {
        // Иконки цветные, шапка слегка синяя, остальное нейтральное.
        if 2 * y < 96 {
            return (140, 118);
        }
        if self.icon_on(2 * x, 2 * y) {
            (100, 160)
        } else {
            (128, 128)
        }
    }
}

/// Спокойная люма + насыщенные хрома-поля (изоляция качества хромы).
struct ChromaGarden {
    seed: u64,
}

impl Painter for ChromaGarden {
    fn luma(&self, _t: i64, x: i64, y: i64) -> u8 {
        (120 + tri(x / 2 + y / 3) / 8) as u8
    }
    fn chroma(&self, _t: i64, x: i64, y: i64) -> (u8, u8) {
        let (ux, uy) = (x.max(0) as u64, y.max(0) as u64);
        let cb = 60 + value_noise(ux, uy, 7, self.seed) * 136 / 255;
        let cr = 60 + value_noise(ux, uy, 7, self.seed ^ 0xF00D) * 136 / 255;
        (cb as u8, cr as u8)
    }
}

/// Движущийся спрайт: прямоугольник с рамкой и диагональной штриховкой тела.
#[derive(Clone, Copy)]
struct Sprite {
    x0_q: i64,
    y0_q: i64,
    vx_q: i64,
    vy_q: i64,
    w_q: i64,
    h_q: i64,
    luma: u8,
    cb: u8,
    cr: u8,
}

/// Спрайты поверх натурального фона (окклюзия и открытие фона).
struct Sprites {
    bg: Landscape,
    sprites: Vec<Sprite>,
}

impl Sprites {
    fn hit(&self, t: i64, x: i64, y: i64) -> Option<(&Sprite, i64, i64)> {
        self.sprites.iter().find_map(|s| {
            let ox = s.x0_q + t * s.vx_q;
            let oy = s.y0_q + t * s.vy_q;
            ((ox..ox + s.w_q).contains(&x) && (oy..oy + s.h_q).contains(&y)).then_some((
                s,
                x - ox,
                y - oy,
            ))
        })
    }
}

impl Painter for Sprites {
    fn luma(&self, t: i64, x: i64, y: i64) -> u8 {
        match self.hit(t, x, y) {
            Some((s, lx, ly)) => {
                let edge = lx.min(s.w_q - 1 - lx).min(ly).min(s.h_q - 1 - ly);
                if edge < 8 {
                    s.luma / 2
                } else if ((lx + ly) / 24) % 2 == 0 {
                    s.luma
                } else {
                    s.luma.saturating_sub(22)
                }
            }
            None => self.bg.luma(t, x, y),
        }
    }
    fn chroma(&self, t: i64, x: i64, y: i64) -> (u8, u8) {
        match self.hit(t, 2 * x, 2 * y) {
            Some((s, _, _)) => (s.cb, s.cr),
            None => self.bg.chroma(t, x, y),
        }
    }
}

/// Темпоральное зерно поверх статичного контента (потолок энтропии,
/// прокси плёночного шума).
struct Grain {
    inner: Landscape,
    amp: i64,
}

impl Painter for Grain {
    fn luma(&self, t: i64, x: i64, y: i64) -> u8 {
        let base = i64::from(self.inner.luma(t, x, y));
        let seed = 0x6EA1u64.wrapping_add((t as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let g = i64::from(lattice_hash(x.max(0) as u64, y.max(0) as u64, seed))
            % (2 * self.amp + 1)
            - self.amp;
        (base + g).clamp(0, 255) as u8
    }
    fn chroma(&self, t: i64, x: i64, y: i64) -> (u8, u8) {
        self.inner.chroma(t, x, y)
    }
}

// ---------------------------------------------------------------------------
// Камера и рендер
// ---------------------------------------------------------------------------

/// Движение камеры; скорости в ¼-пикселях люмы за кадр.
#[derive(Clone, Copy)]
enum Camera {
    Static,
    Pan {
        vx_q: i64,
        vy_q: i64,
    },
    /// Наезд: масштаб s(t) = 1 − t·rate/65536.
    Zoom {
        rate_q16: i64,
    },
    /// Поворот вокруг центра, рад/кадр в Q16.
    Rotate {
        rate_q16: i64,
    },
    /// Дрожание камеры ±amp_q (детерминированное).
    Jitter {
        seed: u64,
        amp_q: i64,
    },
}

impl Camera {
    /// Отображение координат мастера кадра t (центр — (cx, cy)).
    fn map(&self, t: i64, cx: i64, cy: i64, mx: i64, my: i64) -> (i64, i64) {
        match *self {
            Camera::Static => (mx, my),
            Camera::Pan { vx_q, vy_q } => (mx + t * vx_q, my + t * vy_q),
            Camera::Zoom { rate_q16 } => {
                let s = 65536 - t * rate_q16;
                (cx + (((mx - cx) * s) >> 16), cy + (((my - cy) * s) >> 16))
            }
            Camera::Rotate { rate_q16 } => {
                let (sin, cos) = sincos_q16(t * rate_q16);
                let (dx, dy) = (mx - cx, my - cy);
                (
                    cx + ((dx * cos - dy * sin) >> 16),
                    cy + ((dx * sin + dy * cos) >> 16),
                )
            }
            Camera::Jitter { seed, amp_q } => {
                let side = (2 * amp_q + 1) as u64;
                let jx = (u64::from(lattice_hash(t as u64, 1, seed)) % side) as i64 - amp_q;
                let jy = (u64::from(lattice_hash(t as u64, 2, seed)) % side) as i64 - amp_q;
                (mx + jx, my + jy)
            }
        }
    }
}

/// Сцена: painter + камера + длительность в кадрах.
struct Scene {
    painter: Box<dyn Painter>,
    camera: Camera,
}

/// Синтетический клип: последовательность сцен (склейки жёсткие) и
/// опциональный фейд люмы в хвосте.
struct SynthSpec {
    name: &'static str,
    class: &'static str,
    w: usize,
    h: usize,
    fps: u32,
    /// (сцена, число кадров).
    scenes: Vec<(Scene, usize)>,
    /// Затемнение последних N кадров (шаг люмы за кадр).
    fade_tail: Option<(usize, i32)>,
}

impl SynthSpec {
    fn total_frames(&self) -> usize {
        self.scenes.iter().map(|(_, n)| n).sum()
    }

    /// Рендер кадра t (глобальный номер по клипу).
    fn render(&self, t: usize) -> Frame {
        let (mut local, mut idx) = (t, 0);
        while idx + 1 < self.scenes.len() && local >= self.scenes[idx].1 {
            local -= self.scenes[idx].1;
            idx += 1;
        }
        let scene = &self.scenes[idx].0;
        let (w, h) = (self.w, self.h);
        let ti = local as i64;
        let (cx, cy) = ((w * 2) as i64, (h * 2) as i64);
        let (mw, mh) = ((w * 4) as i64, (h * 4) as i64);
        let mut f = Frame::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (sx, sy) = scene.camera.map(ti, cx, cy, (x as i64) * 4, (y as i64) * 4);
                let (sx, sy) = (sx.clamp(0, mw - 1), sy.clamp(0, mh - 1));
                f.y.set(x, y, scene.painter.luma(ti, sx, sy));
            }
        }
        let (cw, ch) = (w / 2, h / 2);
        let (cmw, cmh) = ((cw * 4) as i64, (ch * 4) as i64);
        for cy_ in 0..ch {
            for cx_ in 0..cw {
                let (sx, sy) = scene
                    .camera
                    .map(ti, cx, cy, (cx_ as i64) * 8, (cy_ as i64) * 8);
                let (sx, sy) = ((sx / 2).clamp(0, cmw - 1), (sy / 2).clamp(0, cmh - 1));
                let (cb, cr) = scene.painter.chroma(ti, sx, sy);
                f.cb.set(cx_, cy_, cb);
                f.cr.set(cx_, cy_, cr);
            }
        }
        if let Some((n, delta)) = self.fade_tail {
            let total = self.total_frames();
            if t + n >= total {
                let k = (t + n - total) as i32 + 1;
                for v in f.y.data_mut() {
                    *v = (i32::from(*v) + k * delta).clamp(0, 255) as u8;
                }
            }
        }
        f
    }
}

fn landscape(seed: u64) -> Box<dyn Painter> {
    Box::new(Landscape { seed })
}

/// Манифест синтетики. Классы подобраны под сильные/слабые стороны кодеков:
/// натуральная текстура и движение — хлеб x264/x265, screen content и хрома —
/// потенциальные ниши FRC-V, зерно — потолок энтропии, монтаж — GOP-логика.
fn synth_manifest() -> Vec<SynthSpec> {
    let single = |name, class, w, h, frames, painter, camera| SynthSpec {
        name,
        class,
        w,
        h,
        fps: 30,
        scenes: vec![(Scene { painter, camera }, frames)],
        fade_tail: None,
    };
    vec![
        single(
            "landscape_pan_360p",
            "natural",
            640,
            360,
            96,
            landscape(0xF10A),
            Camera::Pan { vx_q: 5, vy_q: 2 },
        ),
        single(
            "landscape_zoom_360p",
            "natural",
            640,
            360,
            96,
            landscape(0xF10A),
            Camera::Zoom { rate_q16: 320 },
        ),
        single(
            "landscape_jitter_cif",
            "natural",
            352,
            288,
            96,
            landscape(0x7E44),
            Camera::Jitter {
                seed: 0xC0FE,
                amp_q: 6,
            },
        ),
        single(
            "plasma_rotate_cif",
            "organic",
            352,
            288,
            96,
            Box::new(Plasma),
            Camera::Rotate { rate_q16: 240 },
        ),
        single(
            "ui_scroll_360p",
            "screen",
            640,
            360,
            96,
            Box::new(UiText { seed: 0x5EED }),
            Camera::Pan { vx_q: 0, vy_q: 12 },
        ),
        single(
            "ui_static_360p",
            "screen",
            640,
            360,
            96,
            Box::new(UiText { seed: 0xD1A1 }),
            Camera::Static,
        ),
        single(
            "sprites_bounce_360p",
            "objects",
            640,
            360,
            96,
            Box::new(Sprites {
                bg: Landscape { seed: 0xBEE5 },
                sprites: vec![
                    Sprite {
                        x0_q: 200,
                        y0_q: 260,
                        vx_q: 14,
                        vy_q: 5,
                        w_q: 360,
                        h_q: 280,
                        luma: 210,
                        cb: 96,
                        cr: 150,
                    },
                    Sprite {
                        x0_q: 1500,
                        y0_q: 800,
                        vx_q: -9,
                        vy_q: 3,
                        w_q: 240,
                        h_q: 240,
                        luma: 70,
                        cb: 150,
                        cr: 100,
                    },
                    Sprite {
                        x0_q: 900,
                        y0_q: 120,
                        vx_q: 6,
                        vy_q: 9,
                        w_q: 180,
                        h_q: 140,
                        luma: 160,
                        cb: 118,
                        cr: 168,
                    },
                ],
            }),
            Camera::Static,
        ),
        single(
            "chroma_garden_cif",
            "chroma",
            352,
            288,
            96,
            Box::new(ChromaGarden { seed: 0x9A2D }),
            Camera::Pan { vx_q: 3, vy_q: 1 },
        ),
        single(
            "grain_land_360p",
            "grain",
            640,
            360,
            96,
            Box::new(Grain {
                inner: Landscape { seed: 0x11AA },
                amp: 6,
            }),
            Camera::Static,
        ),
        SynthSpec {
            name: "cuts_mix_360p",
            class: "montage",
            w: 640,
            h: 360,
            fps: 30,
            scenes: vec![
                (
                    Scene {
                        painter: landscape(0x33CC),
                        camera: Camera::Pan { vx_q: 6, vy_q: 0 },
                    },
                    32,
                ),
                (
                    Scene {
                        painter: Box::new(UiText { seed: 0xBEEF }),
                        camera: Camera::Static,
                    },
                    32,
                ),
                (
                    Scene {
                        painter: Box::new(Plasma),
                        camera: Camera::Rotate { rate_q16: 200 },
                    },
                    32,
                ),
            ],
            fade_tail: Some((20, -9)),
        },
        single(
            "landscape_pan_720p",
            "scale",
            1280,
            720,
            60,
            landscape(0x720A),
            Camera::Pan { vx_q: 7, vy_q: 3 },
        ),
    ]
}

// ---------------------------------------------------------------------------
// Эталонные клипы (xiph/derf)
// ---------------------------------------------------------------------------

/// Манифест `fetch`: имя → URL (y4m, CIF).
pub const FETCH_MANIFEST: &[(&str, &str)] = &[
    (
        "akiyo_cif",
        "https://media.xiph.org/video/derf/y4m/akiyo_cif.y4m",
    ),
    (
        "foreman_cif",
        "https://media.xiph.org/video/derf/y4m/foreman_cif.y4m",
    ),
    (
        "bus_cif",
        "https://media.xiph.org/video/derf/y4m/bus_cif.y4m",
    ),
    (
        "mobile_cif",
        "https://media.xiph.org/video/derf/y4m/mobile_cif.y4m",
    ),
    (
        "news_cif",
        "https://media.xiph.org/video/derf/y4m/news_cif.y4m",
    ),
    (
        "flower_cif",
        "https://media.xiph.org/video/derf/y4m/flower_cif.y4m",
    ),
];

// ---------------------------------------------------------------------------
// Каталог корпуса и материализация
// ---------------------------------------------------------------------------

/// Источник клипа.
pub enum ClipSource {
    /// Синтетика (индекс в манифесте).
    Synth(usize),
    /// Файл y4m из каталога клипов.
    File(PathBuf),
}

/// Клип корпуса.
pub struct Clip {
    pub name: String,
    pub class: String,
    pub width: usize,
    pub height: usize,
    pub fps_num: u32,
    pub fps_den: u32,
    /// Полное число кадров источника (для файлов — 0 до материализации).
    pub frames: usize,
    pub source: ClipSource,
}

/// Полный каталог: синтетика + все `*.y4m` из каталога клипов.
pub fn catalog(clips_dir: &Path) -> io::Result<Vec<Clip>> {
    let mut out = Vec::new();
    for (i, s) in synth_manifest().iter().enumerate() {
        out.push(Clip {
            name: s.name.to_string(),
            class: s.class.to_string(),
            width: s.w,
            height: s.h,
            fps_num: s.fps,
            fps_den: 1,
            frames: s.total_frames(),
            source: ClipSource::Synth(i),
        });
    }
    if clips_dir.is_dir() {
        let mut files: Vec<PathBuf> = fs::read_dir(clips_dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("y4m")))
            .collect();
        files.sort();
        for p in files {
            let Ok(reader) = File::open(&p).map(BufReader::new).and_then(Y4mReader::new) else {
                eprintln!("предупреждение: пропущен нечитаемый y4m {}", p.display());
                continue;
            };
            let params = reader.params;
            if params.width % 8 != 0 || params.height % 8 != 0 {
                eprintln!(
                    "предупреждение: {} — размеры {}x{} не кратны 8 (FRC-V), клип пропущен",
                    p.display(),
                    params.width,
                    params.height
                );
                continue;
            }
            let name = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(Clip {
                name,
                class: "reference".to_string(),
                width: params.width,
                height: params.height,
                fps_num: params.fps_num,
                fps_den: params.fps_den,
                frames: 0,
                source: ClipSource::File(p),
            });
        }
    }
    Ok(out)
}

/// Кэш синтетики: `<clips_dir>/synth/<name>.s<V>.y4m` (генерируется при
/// первом обращении, дальше переиспользуется).
fn synth_cache_path(clips_dir: &Path, name: &str) -> PathBuf {
    clips_dir
        .join("synth")
        .join(format!("{name}.s{SYNTH_VERSION}.y4m"))
}

fn generate_synth(spec: &SynthSpec, path: &Path) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("y4m.part");
    {
        let params = frc_v::y4m::VideoParams {
            width: spec.w,
            height: spec.h,
            fps_num: spec.fps,
            fps_den: 1,
        };
        let mut w = Y4mWriter::new(BufWriter::new(File::create(&tmp)?), params)?;
        for t in 0..spec.total_frames() {
            w.write_frame(&spec.render(t))?;
        }
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Материализует источник клипа: усечённая до `max_frames` копия y4m в
/// `work_dir`. Возвращает путь и фактическое число кадров.
pub fn materialize(
    clip: &Clip,
    clips_dir: &Path,
    work_dir: &Path,
    max_frames: usize,
) -> io::Result<(PathBuf, usize)> {
    let src: PathBuf = match &clip.source {
        ClipSource::Synth(i) => {
            let specs = synth_manifest();
            let spec = &specs[*i];
            let cache = synth_cache_path(clips_dir, &clip.name);
            if !cache.is_file() {
                eprintln!(
                    "  синтез {} ({}x{}, {} кадров)…",
                    clip.name,
                    spec.w,
                    spec.h,
                    spec.total_frames()
                );
                generate_synth(spec, &cache)?;
            }
            cache
        }
        ClipSource::File(p) => p.clone(),
    };
    fs::create_dir_all(work_dir)?;
    let dst = work_dir.join(format!("{}.src.y4m", clip.name));
    let mut reader = Y4mReader::new(BufReader::new(File::open(&src)?))?;
    let mut writer = Y4mWriter::new(BufWriter::new(File::create(&dst)?), reader.params)?;
    let mut n = 0usize;
    while n < max_frames {
        match reader.read_frame()? {
            Some(f) => {
                writer.write_frame(&f)?;
                n += 1;
            }
            None => break,
        }
    }
    Ok((dst, n))
}

/// Средняя люма плоскости (санити-тесты генераторов).
#[cfg(test)]
fn plane_mean(p: &Plane) -> u32 {
    (p.data().iter().map(|&v| u32::from(v)).sum::<u32>() / p.data().len() as u32).min(255)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synth_manifest_names_unique() {
        let specs = synth_manifest();
        let mut names: Vec<&str> = specs.iter().map(|s| s.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), specs.len());
    }

    #[test]
    fn synth_render_deterministic_and_sane() {
        let specs = synth_manifest();
        for spec in &specs {
            assert!(spec.w % 8 == 0 && spec.h % 8 == 0, "{}", spec.name);
            assert!(spec.total_frames() > 0);
            let a = spec.render(1);
            let b = spec.render(1);
            assert_eq!(a, b, "{} недетерминирован", spec.name);
            let mean = plane_mean(&a.y);
            assert!(
                (20..=240).contains(&mean),
                "{}: подозрительная средняя люма {mean}",
                spec.name
            );
        }
    }

    #[test]
    fn scenes_switch_content() {
        let specs = synth_manifest();
        let cuts = specs.iter().find(|s| s.name == "cuts_mix_360p").unwrap();
        let a = cuts.render(31);
        let b = cuts.render(32);
        // Жёсткая склейка: кадры радикально различаются.
        let diff: u64 =
            a.y.data()
                .iter()
                .zip(b.y.data())
                .map(|(&x, &y)| u64::from(x.abs_diff(y)))
                .sum();
        let mad = diff / a.y.data().len() as u64;
        assert!(mad > 20, "склейка не видна: MAD {mad}");
    }
}
