//! Корпус полигона: детерминированная целочисленная синтетика + эталонные
//! наборы (Kodak, picsum) + пользовательские PNG.
//!
//! Синтетика рендерится целочисленными генераторами (бит-в-бит на всех
//! платформах) и кэшируется в PNG: прогоны воспроизводимы, версия
//! генераторов (`SYNTH_VERSION`) инвалидирует кэш при любой правке.
//! Классы подобраны под инструменты кодера и известные слепые зоны:
//! натуральная текстура и портрет (intra-предикция, дерево блоков), screen
//! и graphics (резкие края, палитра), хрома-нагрузка (4:2:0 и CfL), зерно
//! (потолок энтропии), градиенты (dead-zone, бандинг), частотные сетки
//! (transform), монтаж (смешанный контент), масштаб 1 Мп (тайлы), нечётные
//! размеры (частичные блоки), миниатюра (аватары), альфа, низкий свет.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Версия генераторов: меняется при любой правке синтетики (инвалидация кэша).
pub const SYNTH_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Целочисленные примитивы (та же схема, что у frc-v-polygon)
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

fn clamp8(v: i64) -> u8 {
    v.clamp(0, 255) as u8
}

// ---------------------------------------------------------------------------
// Painter'ы (RGB; альфа — отдельный trait ниже)
// ---------------------------------------------------------------------------

trait Painter {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8);
}

/// Натуральная текстура: fractal noise + пологий вертикальный свет,
/// каналы слегка разведены низкочастотным шумом (фото-подобная хрома).
struct Landscape {
    seed: u64,
}

impl Landscape {
    fn base(&self, x: i64, y: i64) -> i64 {
        let (ux, uy) = (x.max(0) as u64, y.max(0) as u64);
        let n = i64::from(fractal_noise(ux, uy, self.seed));
        26 + n * 175 / 255 + y / 96
    }
}

impl Painter for Landscape {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        let (ux, uy) = (x.max(0) as u64, y.max(0) as u64);
        let base = self.base(x, y);
        let warm = i64::from(value_noise(ux, uy, 7, self.seed ^ 0x0B0B)) * 24 / 255 - 12;
        let cool = i64::from(value_noise(ux, uy, 7, self.seed ^ 0x0C0C)) * 24 / 255 - 12;
        (clamp8(base + warm), clamp8(base), clamp8(base + cool))
    }
}

/// Портрет-прокси: гладкий фон-градиент и пять мягких пятен «кожи»
/// (большие гладкие зоны — хлеб суперблоков и delta-Q).
struct Portrait {
    seed: u64,
}

impl Painter for Portrait {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        // Фон: вертикальный тёплый градиент.
        let mut r = 205 - y * 50 / 512;
        let mut g = 178 - y * 46 / 512;
        let mut b = 152 - y * 40 / 512;
        // Мягкие пятна: вес = линейный спад от центра, целочисленно.
        for i in 0..5u64 {
            let cx = 96 + i64::from(lattice_hash(i, 1, self.seed) % 320);
            let cy = 112 + i64::from(lattice_hash(i, 2, self.seed) % 288);
            let rad = 56 + i64::from(lattice_hash(i, 3, self.seed) % 72);
            let tone = i64::from(lattice_hash(i, 4, self.seed) % 40) - 20;
            let d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
            let r2 = rad * rad;
            if d2 < r2 {
                let w = (r2 - d2) * 255 / r2; // 0..=255
                let tr = 196 + tone;
                let tg = 152 + tone * 3 / 4;
                let tb = 122 + tone / 2;
                r = (r * (255 - w) + tr * w) / 255;
                g = (g * (255 - w) + tg * w) / 255;
                b = (b * (255 - w) + tb * w) / 255;
            }
        }
        (clamp8(r), clamp8(g), clamp8(b))
    }
}

/// Screen content: «приложение» — шапка, разделители строк, псевдотекст
/// из хэш-глифов, цветные «иконки» слева (резкие края, плоские заливки).
struct UiText {
    seed: u64,
}

impl UiText {
    /// Глиф в ячейке 10×14 px: маска 4×5 субклеток по 2×2 px.
    fn glyph_on(&self, x: i64, y: i64) -> bool {
        let (cx, cy) = (x.div_euclid(10), y.div_euclid(14));
        let (ix, iy) = (x.rem_euclid(10), y.rem_euclid(14));
        if !(1..9).contains(&ix) || !(2..12).contains(&iy) {
            return false;
        }
        let bits = lattice_hash(cx as u64, cy as u64, self.seed);
        // «Пробел» примерно в четверти ячеек — рваные строки, как в тексте.
        if bits & 0xC000_0000 == 0 {
            return false;
        }
        let (sx, sy) = ((ix - 1) / 2, (iy - 2) / 2);
        bits >> (sy * 4 + sx) & 1 == 1
    }

    /// Иконка: квадрат 12×12 px в начале каждой «строки списка» высотой 32.
    fn icon_on(&self, x: i64, y: i64) -> bool {
        let row = y.div_euclid(32);
        let iy = y.rem_euclid(32);
        (4..16).contains(&x) && (10..22).contains(&iy) && row.rem_euclid(2) == 0
    }
}

impl Painter for UiText {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        // Шапка приложения.
        if y < 24 {
            return if self.glyph_on(x - 8, y - 5) {
                (235, 237, 240)
            } else {
                (46, 52, 64)
            };
        }
        // Тонкий разделитель каждой строки списка.
        if y.rem_euclid(32) < 1 {
            return (196, 199, 203);
        }
        if self.icon_on(x, y) {
            return (64, 108, 188);
        }
        // Текст в колонку с отступом под иконку.
        if x > 24 && self.glyph_on(x - 24, y - 3) {
            (34, 36, 40)
        } else {
            (243, 244, 246)
        }
    }
}

/// Графика: плоская палитра из шести цветов, резкие геометрические формы.
struct Graphics {
    seed: u64,
}

impl Painter for Graphics {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        const PALETTE: [(u8, u8, u8); 6] = [
            (238, 245, 247),
            (24, 28, 36),
            (206, 54, 62),
            (38, 122, 186),
            (240, 178, 42),
            (52, 148, 90),
        ];
        let (cx, cy) = (x.div_euclid(128), y.div_euclid(128));
        let h = lattice_hash(cx as u64, cy as u64, self.seed);
        let bg = PALETTE[(h % 6) as usize];
        let fg = PALETTE[((h / 6 + 1) % 6) as usize];
        let (ix, iy) = (x.rem_euclid(128) - 64, y.rem_euclid(128) - 64);
        // Чётные ячейки — круг, нечётные — ромб, каждая третья — полосы.
        let shape = match h % 3 {
            0 => ix * ix + iy * iy < 40 * 40,
            1 => ix.abs() + iy.abs() < 44,
            _ => (x + y).rem_euclid(24) < 8,
        };
        if shape { fg } else { bg }
    }
}

/// Спокойная люма + насыщенные хрома-поля (изоляция пути 4:2:0 и CfL).
/// Считается в YCbCr BT.601 и переводится в RGB целочисленно.
struct ChromaGarden {
    seed: u64,
}

impl Painter for ChromaGarden {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        let (ux, uy) = (x.max(0) as u64, y.max(0) as u64);
        let yy = 120 + tri(x / 2 + y / 3) / 8;
        let cb = 60 + i64::from(value_noise(ux, uy, 7, self.seed)) * 136 / 255;
        let cr = 60 + i64::from(value_noise(ux, uy, 7, self.seed ^ 0xF00D)) * 136 / 255;
        // YCbCr → RGB (BT.601 full-range, фиксированная точка 1/256).
        let r = yy + ((cr - 128) * 359) / 256;
        let b = yy + ((cb - 128) * 454) / 256;
        let g = yy - ((cb - 128) * 88 + (cr - 128) * 183) / 256;
        (clamp8(r), clamp8(g), clamp8(b))
    }
}

/// Зерно поверх натуральной основы (потолок энтропии, прокси плёночного
/// шума и высокого ISO).
struct Grain {
    inner: Landscape,
    amp: i64,
}

impl Painter for Grain {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        let (r, g, b) = self.inner.rgb(x, y);
        let noise = |c: u8, chan: u64| {
            let seed = 0x6EA1u64 ^ chan.wrapping_mul(0x9E37_79B9_7F4A_7C15);
            let n = i64::from(lattice_hash(x.max(0) as u64, y.max(0) as u64, seed))
                % (2 * self.amp + 1)
                - self.amp;
            clamp8(i64::from(c) + n)
        };
        (noise(r, 1), noise(g, 2), noise(b, 3))
    }
}

/// Медленные диагональные градиенты с цветовым фазовым сдвигом
/// (dead-zone квантования, бандинг, низкая энтропия AC).
struct GradientWash;

impl Painter for GradientWash {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        let r = 128 + ((x - 256) * 3 + (y - 256) * 5) / 24;
        let g = 128 + ((y - 256) * 3 - (x - 256) * 2) / 26;
        let b = 128 + ((x - 256) + (y - 256)) / 30 + tri((x * x + y * y) >> 12) / 12;
        (clamp8(r), clamp8(g), clamp8(b))
    }
}

/// Частотные сетки и тонкие линии (выбор transform, предотбор мод,
/// хрома-края): вертикали 16 px, горизонтали 32 px, шахматки 8 и 2 px,
/// красная диагональ.
struct Edges;

impl Painter for Edges {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        // Красная диагональ (хрома-крань на нейтральном фоне).
        if (x + y).rem_euclid(64) < 2 {
            return (212, 34, 40);
        }
        // Шахматки в нижних квадрантах.
        if y >= 256 {
            let cell = if x < 256 { 8 } else { 2 };
            let on = (x.div_euclid(cell) + y.div_euclid(cell)) % 2 == 0;
            return if on { (232, 232, 232) } else { (24, 24, 28) };
        }
        // Линейные сетки в верхней половине.
        if x.rem_euclid(16) == 0 {
            return (20, 20, 24);
        }
        if y.rem_euclid(32) == 0 {
            return (236, 236, 238);
        }
        (128, 128, 130)
    }
}

/// Монтаж 2×2: натуральное / screen / градиент / зерно (смешанный контент
/// в одном кадре, тайлы с разной статистикой).
struct Collage {
    land: Landscape,
    ui: UiText,
    grad: GradientWash,
    grain: Grain,
}

impl Painter for Collage {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        let (lx, ly) = (x.rem_euclid(384), y.rem_euclid(256));
        match (x >= 384, y >= 256) {
            (false, false) => self.land.rgb(lx * 2, ly * 2),
            (true, false) => self.ui.rgb(lx * 2, ly * 2),
            (false, true) => self.grad.rgb(lx, ly),
            (true, true) => self.grain.rgb(lx, ly),
        }
    }
}

/// Ночной кадр: узкий диапазон 4..48 + зерно (dead-zone и хрома-шум
/// в тенях; исторически слепая зона PSNR-калибровок).
struct LowLight {
    inner: Landscape,
}

impl Painter for LowLight {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        let (r, g, b) = self.inner.rgb(x, y);
        let dark = |c: u8, chan: u64| {
            let n = i64::from(lattice_hash(x.max(0) as u64, y.max(0) as u64, 0xD4 ^ chan)) % 7 - 3;
            clamp8(4 + i64::from(c) * 44 / 255 + n)
        };
        (dark(r, 1), dark(g, 2), dark(b, 3))
    }
}

/// Миниатюра-аватар: одно крупное мягкое пятно на градиенте.
struct Avatar {
    seed: u64,
}

impl Painter for Avatar {
    fn rgb(&self, x: i64, y: i64) -> (u8, u8, u8) {
        let mut r = 96 + y * 64 / 128;
        let mut g = 110 + y * 40 / 128;
        let mut b = 150 + y * 24 / 128;
        let cx = 44 + (self.seed % 40) as i64;
        let cy = 40 + ((self.seed / 7) % 32) as i64;
        let d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        let r2 = 30 * 30;
        if d2 < r2 {
            let w = (r2 - d2) * 255 / r2;
            r = (r * (255 - w) + 202 * w) / 255;
            g = (g * (255 - w) + 158 * w) / 255;
            b = (b * (255 - w) + 126 * w) / 255;
        }
        (clamp8(r), clamp8(g), clamp8(b))
    }
}

/// Альфа-композиция: прозрачный фон, перекрывающиеся фигуры с разной
/// непрозрачностью (альфа кодируется lossless всегда — отдельная ось).
struct AlphaShapes;

impl AlphaShapes {
    fn rgba(&self, x: i64, y: i64) -> (u8, u8, u8, u8) {
        let mut out = (0u8, 0u8, 0u8, 0u8);
        // Прямоугольник с четверть-прозрачностью.
        if (96..416).contains(&x) && (160..352).contains(&y) {
            out = (240, 178, 42, 64);
        }
        /// (центр x, центр y, радиус, цвет, альфа).
        type Shape = (i64, i64, i64, (u8, u8, u8), u8);
        let shapes: [Shape; 3] = [
            (180, 190, 110, (206, 54, 62), 255),
            (300, 240, 120, (38, 122, 186), 192),
            (360, 330, 90, (52, 148, 90), 128),
        ];
        for (cx, cy, rad, color, a) in shapes {
            let d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
            if d2 < rad * rad {
                out = (color.0, color.1, color.2, a);
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Манифест синтетики
// ---------------------------------------------------------------------------

/// Синтетическое изображение манифеста.
struct SynthSpec {
    name: &'static str,
    class: &'static str,
    w: u32,
    h: u32,
    kind: SynthKind,
}

enum SynthKind {
    Rgb(fn(&SynthSpec) -> Box<dyn Painter>),
    Rgba,
}

impl SynthSpec {
    /// Рендер: RGB-буфер (`Rgb8`) либо RGBA (`Rgba8`), строго детерминирован.
    fn render(&self) -> (Vec<u8>, bool) {
        let (w, h) = (self.w as usize, self.h as usize);
        match &self.kind {
            SynthKind::Rgb(make) => {
                let p = make(self);
                let mut buf = vec![0u8; w * h * 3];
                for y in 0..h {
                    for x in 0..w {
                        let (r, g, b) = p.rgb(x as i64, y as i64);
                        let o = (y * w + x) * 3;
                        buf[o] = r;
                        buf[o + 1] = g;
                        buf[o + 2] = b;
                    }
                }
                (buf, false)
            }
            SynthKind::Rgba => {
                let p = AlphaShapes;
                let mut buf = vec![0u8; w * h * 4];
                for y in 0..h {
                    for x in 0..w {
                        let (r, g, b, a) = p.rgba(x as i64, y as i64);
                        let o = (y * w + x) * 4;
                        buf[o] = r;
                        buf[o + 1] = g;
                        buf[o + 2] = b;
                        buf[o + 3] = a;
                    }
                }
                (buf, true)
            }
        }
    }
}

/// Манифест синтетики. Классы — оси анализа отчёта; состав закрывает
/// инструменты кодера и исторические слепые зоны калибровок PSNR-эпохи.
fn synth_manifest() -> Vec<SynthSpec> {
    vec![
        SynthSpec {
            name: "photo_landscape_768",
            class: "natural",
            w: 768,
            h: 512,
            kind: SynthKind::Rgb(|_| Box::new(Landscape { seed: 0xF10A })),
        },
        SynthSpec {
            name: "photo_odd_501x375",
            class: "natural",
            w: 501,
            h: 375,
            kind: SynthKind::Rgb(|_| Box::new(Landscape { seed: 0x0DD5 })),
        },
        SynthSpec {
            name: "portrait_smooth_512",
            class: "portrait",
            w: 512,
            h: 512,
            kind: SynthKind::Rgb(|_| Box::new(Portrait { seed: 0xA17E })),
        },
        SynthSpec {
            name: "ui_screen_768",
            class: "screen",
            w: 768,
            h: 512,
            kind: SynthKind::Rgb(|_| Box::new(UiText { seed: 0x5EED })),
        },
        SynthSpec {
            name: "graphics_palette_512",
            class: "graphics",
            w: 512,
            h: 512,
            kind: SynthKind::Rgb(|_| Box::new(Graphics { seed: 0x6AF1 })),
        },
        SynthSpec {
            name: "chroma_garden_512",
            class: "chroma",
            w: 512,
            h: 512,
            kind: SynthKind::Rgb(|_| Box::new(ChromaGarden { seed: 0x9A2D })),
        },
        SynthSpec {
            name: "grain_noise_512",
            class: "grain",
            w: 512,
            h: 512,
            kind: SynthKind::Rgb(|_| {
                Box::new(Grain {
                    inner: Landscape { seed: 0x11AA },
                    amp: 8,
                })
            }),
        },
        SynthSpec {
            name: "gradient_wash_512",
            class: "gradient",
            w: 512,
            h: 512,
            kind: SynthKind::Rgb(|_| Box::new(GradientWash)),
        },
        SynthSpec {
            name: "edges_lines_512",
            class: "edges",
            w: 512,
            h: 512,
            kind: SynthKind::Rgb(|_| Box::new(Edges)),
        },
        SynthSpec {
            name: "mixed_collage_768",
            class: "mixed",
            w: 768,
            h: 512,
            kind: SynthKind::Rgb(|_| {
                Box::new(Collage {
                    land: Landscape { seed: 0x33CC },
                    ui: UiText { seed: 0xBEEF },
                    grad: GradientWash,
                    grain: Grain {
                        inner: Landscape { seed: 0x7711 },
                        amp: 10,
                    },
                })
            }),
        },
        SynthSpec {
            name: "scale_photo_1024",
            class: "scale",
            w: 1024,
            h: 1024,
            kind: SynthKind::Rgb(|_| Box::new(Landscape { seed: 0x720A })),
        },
        SynthSpec {
            name: "night_lowlight_512",
            class: "lowlight",
            w: 512,
            h: 512,
            kind: SynthKind::Rgb(|_| {
                Box::new(LowLight {
                    inner: Landscape { seed: 0xD00D },
                })
            }),
        },
        SynthSpec {
            name: "avatar_128",
            class: "small",
            w: 128,
            h: 128,
            kind: SynthKind::Rgb(|_| Box::new(Avatar { seed: 0xB1 })),
        },
        SynthSpec {
            name: "alpha_shapes_512",
            class: "alpha",
            w: 512,
            h: 512,
            kind: SynthKind::Rgba,
        },
    ]
}

// ---------------------------------------------------------------------------
// Эталонные наборы (fetch)
// ---------------------------------------------------------------------------

/// Зеркала Kodak PhotoCD (24 кадра 768×512 PNG, `kodim01`..`kodim24`).
/// Канонический источник — r0k.us, но он может отдавать 403 (защита от
/// хотлинка/ботов); зеркало castano/image-datasets на GitHub совпадает
/// байт-в-байт (контроль по каноническим размерам ниже).
pub const KODAK_MIRRORS: &[&str] = &[
    "https://raw.githubusercontent.com/castano/image-datasets/master/kodak",
    "https://r0k.us/graphics/kodak/kodak",
    "http://r0k.us/graphics/kodak/kodak",
];

/// Канонические размеры файлов Kodak (байты, из листинга r0k.us) — контроль
/// целостности при скачивании с зеркал (отсекает усечённые ответы и
/// HTML-страницы ошибок, отданные с кодом 200).
pub const KODAK_SIZES: [u64; 24] = [
    736501, 617995, 502888, 637432, 785610, 618959, 566322, 788470, 582899, 593463, 621023, 531024,
    822712, 692201, 612582, 534247, 602078, 780947, 671476, 492462, 637051, 701970, 557596, 706397,
];

/// Имена кадров Kodak.
pub fn kodak_names() -> Vec<String> {
    (1..=24).map(|i| format!("kodim{i:02}")).collect()
}

/// URL кадра picsum (JPEG 768×512 по зерну; конвертируется в PNG при fetch).
pub fn picsum_url(n: u32) -> String {
    format!("https://picsum.photos/seed/picsum{n}/768/512.jpg")
}

/// Число кадров picsum-набора.
pub const PICSUM_COUNT: u32 = 12;

// ---------------------------------------------------------------------------
// Каталог корпуса и материализация
// ---------------------------------------------------------------------------

/// Источник изображения.
pub enum ImageSource {
    /// Синтетика (индекс в манифесте).
    Synth(usize),
    /// PNG из каталога корпуса (эталонные наборы, пользовательские).
    File(PathBuf),
}

/// Изображение корпуса.
pub struct Image {
    pub name: String,
    pub class: String,
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub source: ImageSource,
}

/// Полный каталог: синтетика + все `*.png` из корня каталога корпуса
/// (подкаталог `synth/` — служебный кэш, в корпус не входит).
pub fn catalog(images_dir: &Path) -> io::Result<Vec<Image>> {
    let mut out = Vec::new();
    for (i, s) in synth_manifest().iter().enumerate() {
        out.push(Image {
            name: s.name.to_string(),
            class: s.class.to_string(),
            width: s.w,
            height: s.h,
            has_alpha: matches!(s.kind, SynthKind::Rgba),
            source: ImageSource::Synth(i),
        });
    }
    if images_dir.is_dir() {
        let mut files: Vec<PathBuf> = fs::read_dir(images_dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")))
            .collect();
        files.sort();
        for p in files {
            let Ok(reader) = image::ImageReader::open(&p) else {
                eprintln!("предупреждение: пропущен нечитаемый PNG {}", p.display());
                continue;
            };
            let Ok((w, h)) = reader.into_dimensions() else {
                eprintln!(
                    "предупреждение: {} — не читаются размеры, пропуск",
                    p.display()
                );
                continue;
            };
            let name = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(Image {
                name,
                class: "reference".to_string(),
                width: w,
                height: h,
                has_alpha: false,
                source: ImageSource::File(p),
            });
        }
    }
    Ok(out)
}

/// Кэш синтетики: `<images_dir>/synth/<name>.s<V>.png` (генерируется при
/// первом обращении, дальше переиспользуется).
fn synth_cache_path(images_dir: &Path, name: &str) -> PathBuf {
    images_dir
        .join("synth")
        .join(format!("{name}.s{SYNTH_VERSION}.png"))
}

fn generate_synth(spec: &SynthSpec, path: &Path) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    // Временный файл с расширением .png: `image` выбирает формат по нему.
    let tmp = path.with_extension("tmp.png");
    let (buf, alpha) = spec.render();
    let color = if alpha {
        image::ExtendedColorType::Rgba8
    } else {
        image::ExtendedColorType::Rgb8
    };
    image::save_buffer(&tmp, &buf, spec.w, spec.h, color)
        .map_err(|e| io::Error::other(format!("запись {}: {e}", tmp.display())))?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Материализует источник: для синтетики — путь к PNG-кэшу (генерируя при
/// необходимости), для файлов — исходный путь.
pub fn materialize(image: &Image, images_dir: &Path) -> io::Result<PathBuf> {
    match &image.source {
        ImageSource::Synth(i) => {
            let specs = synth_manifest();
            let spec = &specs[*i];
            let cache = synth_cache_path(images_dir, &image.name);
            if !cache.is_file() {
                eprintln!(
                    "  синтез {} ({}x{})…",
                    image.name, image.width, image.height
                );
                generate_synth(spec, &cache)?;
            }
            Ok(cache)
        }
        ImageSource::File(p) => Ok(p.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kodak_sizes_match_names() {
        assert_eq!(kodak_names().len(), KODAK_SIZES.len());
        assert!(!KODAK_MIRRORS.is_empty());
    }

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
        for spec in synth_manifest() {
            let a = spec.render();
            let b = spec.render();
            assert_eq!(a, b, "{} недетерминирован", spec.name);
            let (buf, alpha) = a;
            let ch = if alpha { 4 } else { 3 };
            assert_eq!(buf.len(), spec.w as usize * spec.h as usize * ch);
            let mean: u64 = buf.iter().map(|&v| u64::from(v)).sum::<u64>() / buf.len() as u64;
            assert!(
                (4..=250).contains(&mean),
                "{}: подозрительное среднее {mean}",
                spec.name
            );
        }
    }

    #[test]
    fn alpha_image_has_transparent_and_opaque() {
        let specs = synth_manifest();
        let spec = specs.iter().find(|s| s.name == "alpha_shapes_512").unwrap();
        let (buf, alpha) = spec.render();
        assert!(alpha);
        let transparent = buf.chunks(4).filter(|p| p[3] == 0).count();
        let opaque = buf.chunks(4).filter(|p| p[3] == 255).count();
        assert!(transparent > 0 && opaque > 0);
    }

    #[test]
    fn odd_size_is_odd() {
        let specs = synth_manifest();
        let spec = specs
            .iter()
            .find(|s| s.name == "photo_odd_501x375")
            .unwrap();
        assert!(spec.w % 2 == 1 && spec.h % 2 == 1);
    }
}
