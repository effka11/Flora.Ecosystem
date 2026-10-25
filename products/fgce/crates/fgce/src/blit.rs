//! Raster blit: `Crisp` and integer `Area` box filter (`fgce.md` §8.2).

use crate::color::{self, Premul, pm};
use crate::contract::{Blend, Color, Error, PixelFormat, Rect, Sample};
use crate::span;

/// Read-only image view passed from `frame`; `blit` does not know the store.
pub(crate) struct ImageView<'a> {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) format: PixelFormat,
    pub(crate) data: &'a [u8],
}

impl ImageView<'_> {
    fn bpp(&self) -> usize {
        match self.format {
            PixelFormat::Alpha8 => 1,
            PixelFormat::Rgb8 | PixelFormat::Rgba8 => 4,
        }
    }

    fn row(&self, y: u32) -> &[u8] {
        let stride = self.width as usize * self.bpp();
        let start = y as usize * stride;
        &self.data[start..start + stride]
    }

    fn rgba(&self, x: u32, y: u32) -> [u8; 4] {
        let offset = (y as usize * self.width as usize + x as usize) * 4;
        let mut texel = [0_u8; 4];
        texel.copy_from_slice(&self.data[offset..offset + 4]);
        texel
    }

    fn coverage(&self, x: u32, y: u32) -> u8 {
        self.data[y as usize * self.width as usize + x as usize]
    }
}

pub(crate) struct BlitOp {
    pub(crate) dest: Rect,
    pub(crate) src: Rect,
    pub(crate) sample: Sample,
    pub(crate) tint: Option<Color>,
    pub(crate) blend: Blend,
}

const WHITE: Color = Color {
    r: 255,
    g: 255,
    b: 255,
    a: 255,
};

pub(crate) fn blit(
    bytes: &mut [u8],
    stride: usize,
    view: Rect,
    image: &ImageView<'_>,
    op: &BlitOp,
) -> Result<(), Error> {
    if op.src.is_empty() || op.dest.is_empty() {
        return Ok(());
    }
    if op.src.x1 < 0
        || op.src.y1 < 0
        || op.src.x2 >= image.width as i32
        || op.src.y2 >= image.height as i32
    {
        return Err(Error::BufferLayout);
    }

    let tint = op.tint.unwrap_or(WHITE);
    if can_copy_row(image, op, tint) {
        copy_rows(bytes, stride, image, view, op);
        return Ok(());
    }

    let src_w = op.src.width();
    let src_h = op.src.height();
    let dest_w = op.dest.width();
    let dest_h = op.dest.height();
    for y in view.y1..=view.y2 {
        let row_start = y as usize * stride;
        let row = &mut bytes[row_start..row_start + stride];
        let dy = y as i64 - op.dest.y1 as i64;
        for x in view.x1..=view.x2 {
            let dx = x as i64 - op.dest.x1 as i64;
            let pixel = match op.sample {
                Sample::Crisp => {
                    let sx = op.src.x1 as i64 + dx * src_w / dest_w;
                    let sy = op.src.y1 as i64 + dy * src_h / dest_h;
                    sample_texel(image, sx as u32, sy as u32, tint)
                }
                Sample::Area => area_texel(image, op.src, dest_w, dest_h, dx, dy, tint),
            };
            span::paint_premul(row, x, x, pixel, op.blend);
        }
    }
    Ok(())
}

fn can_copy_row(image: &ImageView<'_>, op: &BlitOp, tint: Color) -> bool {
    if tint != WHITE {
        return false;
    }
    if op.src.width() != op.dest.width() || op.src.height() != op.dest.height() {
        return false;
    }
    match op.blend {
        Blend::Src => image.format != PixelFormat::Alpha8,
        Blend::SrcOver => image.format == PixelFormat::Rgb8,
        Blend::Clear | Blend::DstOut => false,
    }
}

fn copy_rows(bytes: &mut [u8], stride: usize, image: &ImageView<'_>, view: Rect, op: &BlitOp) {
    let dx = view.x1 as i64 - op.dest.x1 as i64;
    let sx = (op.src.x1 as i64 + dx) as usize;
    let count = (view.x2 - view.x1 + 1) as usize * 4;
    for y in view.y1..=view.y2 {
        let dy = y as i64 - op.dest.y1 as i64;
        let sy = (op.src.y1 as i64 + dy) as u32;
        let source = image.row(sy);
        let start = sx * 4;
        let row_start = y as usize * stride;
        let row = &mut bytes[row_start..row_start + stride];
        span::copy_row_premul(row, view.x1, view.x2, &source[start..start + count]);
    }
}

fn sample_texel(image: &ImageView<'_>, x: u32, y: u32, tint: Color) -> Premul {
    match image.format {
        PixelFormat::Alpha8 => tint_coverage(image.coverage(x, y), tint),
        PixelFormat::Rgb8 | PixelFormat::Rgba8 => tint_rgba(image.rgba(x, y), tint),
    }
}

fn area_texel(
    image: &ImageView<'_>,
    src: Rect,
    dest_w: i64,
    dest_h: i64,
    dx: i64,
    dy: i64,
    tint: Color,
) -> Premul {
    let src_w = src.width();
    let src_h = src.height();
    let divisor = (src_w * src_h) as u64;
    let left_x = dx * src_w;
    let right_x = left_x + src_w;
    let left_y = dy * src_h;
    let right_y = left_y + src_h;
    let i0 = left_x / dest_w;
    let i1 = (right_x - 1) / dest_w;
    let j0 = left_y / dest_h;
    let j1 = (right_y - 1) / dest_h;

    if image.format == PixelFormat::Alpha8 {
        let mut sum = 0_u64;
        for j in j0..=j1 {
            let oy = right_y.min((j + 1) * dest_h) - left_y.max(j * dest_h);
            for i in i0..=i1 {
                let ox = right_x.min((i + 1) * dest_w) - left_x.max(i * dest_w);
                let x = (src.x1 as i64 + i) as u32;
                let y = (src.y1 as i64 + j) as u32;
                sum += image.coverage(x, y) as u64 * ox as u64 * oy as u64;
            }
        }
        let coverage = ((sum + divisor / 2) / divisor) as u8;
        return tint_coverage(coverage, tint);
    }

    let mut sums = [0_u64; 4];
    for j in j0..=j1 {
        let oy = right_y.min((j + 1) * dest_h) - left_y.max(j * dest_h);
        for i in i0..=i1 {
            let ox = right_x.min((i + 1) * dest_w) - left_x.max(i * dest_w);
            let x = (src.x1 as i64 + i) as u32;
            let y = (src.y1 as i64 + j) as u32;
            let texel = image.rgba(x, y);
            let weight = ox as u64 * oy as u64;
            for channel in 0..4 {
                sums[channel] += texel[channel] as u64 * weight;
            }
        }
    }
    let mut texel = [0_u8; 4];
    for channel in 0..4 {
        texel[channel] = ((sums[channel] + divisor / 2) / divisor) as u8;
    }
    tint_rgba(texel, tint)
}

fn tint_rgba(texel: [u8; 4], tint: Color) -> Premul {
    let a = texel[3];
    let straight_r = color::straight(texel[0], a);
    let straight_g = color::straight(texel[1], a);
    let straight_b = color::straight(texel[2], a);
    let tinted_a = ((a as u32 * tint.a as u32 + 127) / 255) as u8;
    Premul {
        r: pm(
            ((straight_r as u32 * tint.r as u32 + 127) / 255) as u8,
            tinted_a,
        ),
        g: pm(
            ((straight_g as u32 * tint.g as u32 + 127) / 255) as u8,
            tinted_a,
        ),
        b: pm(
            ((straight_b as u32 * tint.b as u32 + 127) / 255) as u8,
            tinted_a,
        ),
        a: tinted_a,
    }
}

fn tint_coverage(coverage: u8, tint: Color) -> Premul {
    let a = ((tint.a as u32 * coverage as u32 + 127) / 255) as u8;
    Premul {
        r: pm(tint.r, a),
        g: pm(tint.g, a),
        b: pm(tint.b, a),
        a,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;
    use crate::contract::{AlphaMode, ImageId, Request, Response};

    fn engine_with_rgb(width: u32, height: u32, pixels: &[u8]) -> Engine {
        let mut engine = Engine::new();
        assert!(matches!(
            engine
                .submit(Request::Begin {
                    width: 8,
                    height: 8
                })
                .unwrap(),
            Response::None
        ));
        let upload = Request::Upload {
            id: ImageId(1),
            width,
            height,
            stride: width * 3,
            format: PixelFormat::Rgb8,
            alpha: AlphaMode::Straight,
            bytes: pixels,
        };
        assert!(matches!(engine.submit(upload).unwrap(), Response::None));
        engine
    }

    fn pixel(engine: &mut Engine, x: i32, y: i32) -> [u8; 4] {
        let response = engine
            .submit(Request::ReadPixels {
                rect: Rect {
                    x1: x,
                    y1: y,
                    x2: x,
                    y2: y,
                },
                alpha: AlphaMode::Premul,
            })
            .unwrap();
        let Response::Pixels(pixels) = response else {
            panic!("expected pixels");
        };
        pixels.bytes[0..4].try_into().unwrap()
    }

    fn blit(
        engine: &mut Engine,
        dest: Rect,
        src: Rect,
        sample: Sample,
        tint: Option<Color>,
        blend: Option<Blend>,
    ) {
        let op = Request::Blit {
            id: ImageId(1),
            dest,
            src,
            sample,
            tint,
            blend,
            radius: None,
        };
        assert!(matches!(engine.submit(op).unwrap(), Response::None));
    }

    #[test]
    fn crisp_copy_rgb() {
        let mut engine = engine_with_rgb(2, 1, &[10, 20, 30, 40, 50, 60]);
        blit(
            &mut engine,
            Rect {
                x1: 0,
                y1: 0,
                x2: 1,
                y2: 0,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 1,
                y2: 0,
            },
            Sample::Crisp,
            None,
            None,
        );
        assert_eq!(pixel(&mut engine, 0, 0), [10, 20, 30, 255]);
        assert_eq!(pixel(&mut engine, 1, 0), [40, 50, 60, 255]);
    }

    #[test]
    fn crisp_tint() {
        let mut engine = engine_with_rgb(1, 1, &[255, 255, 255]);
        blit(
            &mut engine,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Sample::Crisp,
            Some(Color {
                r: 128,
                g: 128,
                b: 128,
                a: 255,
            }),
            None,
        );
        assert_eq!(pixel(&mut engine, 0, 0), [128, 128, 128, 255]);
        blit(
            &mut engine,
            Rect {
                x1: 1,
                y1: 0,
                x2: 1,
                y2: 0,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Sample::Crisp,
            Some(WHITE),
            Some(Blend::SrcOver),
        );
        assert_eq!(pixel(&mut engine, 1, 0), [255, 255, 255, 255]);
    }

    #[test]
    fn crisp_tint_alpha() {
        let mut engine = engine_with_rgb(1, 1, &[255, 255, 255]);
        blit(
            &mut engine,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Sample::Crisp,
            Some(Color {
                r: 255,
                g: 255,
                b: 255,
                a: 128,
            }),
            None,
        );
        assert_eq!(pixel(&mut engine, 0, 0), [128, 128, 128, 128]);
    }

    #[test]
    fn area_two_by_one() {
        // Source rows "1 2" / "3 4" / "5 6" as grayscale pixels, dest 1x2.
        let mut engine = engine_with_rgb(
            2,
            3,
            &[1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6],
        );
        blit(
            &mut engine,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 1,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 1,
                y2: 2,
            },
            Sample::Area,
            None,
            None,
        );
        assert_eq!(pixel(&mut engine, 0, 0), [2, 2, 2, 255]);
        assert_eq!(pixel(&mut engine, 0, 1), [5, 5, 5, 255]);
    }

    #[test]
    fn area_tint_channel_one() {
        let mut engine = engine_with_rgb(2, 1, &[0, 0, 0, 200, 200, 200]);
        blit(
            &mut engine,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 1,
                y2: 0,
            },
            Sample::Area,
            Some(Color {
                r: 1,
                g: 1,
                b: 1,
                a: 255,
            }),
            None,
        );
        assert_eq!(pixel(&mut engine, 0, 0), [0, 0, 0, 255]);
    }

    #[test]
    fn alpha8_coverage() {
        let mut engine = Engine::new();
        engine
            .submit(Request::Begin {
                width: 4,
                height: 4,
            })
            .unwrap();
        engine
            .submit(Request::Upload {
                id: ImageId(1),
                width: 1,
                height: 1,
                stride: 1,
                format: PixelFormat::Alpha8,
                alpha: AlphaMode::Straight,
                bytes: &[128],
            })
            .unwrap();
        blit(
            &mut engine,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Sample::Crisp,
            None,
            None,
        );
        assert_eq!(pixel(&mut engine, 0, 0), [128, 128, 128, 128]);
    }

    #[test]
    fn rgba_tint_example() {
        let mut engine = Engine::new();
        engine
            .submit(Request::Begin {
                width: 2,
                height: 2,
            })
            .unwrap();
        engine
            .submit(Request::Upload {
                id: ImageId(1),
                width: 1,
                height: 1,
                stride: 4,
                format: PixelFormat::Rgba8,
                alpha: AlphaMode::Premul,
                bytes: &[200, 200, 200, 200],
            })
            .unwrap();
        blit(
            &mut engine,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Sample::Crisp,
            Some(Color {
                r: 255,
                g: 255,
                b: 255,
                a: 100,
            }),
            None,
        );
        assert_eq!(pixel(&mut engine, 0, 0), [78, 78, 78, 78]);
    }

    #[test]
    fn blend_modes() {
        let mut engine = engine_with_rgb(1, 1, &[100, 100, 100]);
        blit(
            &mut engine,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Sample::Crisp,
            None,
            Some(Blend::Src),
        );
        assert_eq!(pixel(&mut engine, 0, 0), [100, 100, 100, 255]);
        blit(
            &mut engine,
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            Sample::Crisp,
            None,
            Some(Blend::Clear),
        );
        assert_eq!(pixel(&mut engine, 0, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn src_outside_image_is_buffer_layout() {
        let mut engine = engine_with_rgb(1, 1, &[1, 2, 3]);
        let error = engine
            .submit(Request::Blit {
                id: ImageId(1),
                dest: Rect {
                    x1: 0,
                    y1: 0,
                    x2: 0,
                    y2: 0,
                },
                src: Rect {
                    x1: 0,
                    y1: 0,
                    x2: 1,
                    y2: 0,
                },
                sample: Sample::Crisp,
                tint: None,
                blend: None,
                radius: None,
            })
            .unwrap_err();
        assert_eq!(error, Error::BufferLayout);
    }

    #[test]
    fn area_equal_sizes_copies_source() {
        let mut engine = engine_with_rgb(2, 1, &[7, 7, 7, 9, 9, 9]);
        blit(
            &mut engine,
            Rect {
                x1: 0,
                y1: 0,
                x2: 1,
                y2: 0,
            },
            Rect {
                x1: 0,
                y1: 0,
                x2: 1,
                y2: 0,
            },
            Sample::Area,
            None,
            None,
        );
        assert_eq!(pixel(&mut engine, 0, 0), [7, 7, 7, 255]);
        assert_eq!(pixel(&mut engine, 1, 0), [9, 9, 9, 255]);
    }

    #[test]
    fn equal_sizes_take_the_row_copy_path() {
        let equal = Rect {
            x1: 0,
            y1: 0,
            x2: 1,
            y2: 0,
        };
        let op = |src: Rect, blend: Blend| BlitOp {
            dest: equal,
            src,
            sample: Sample::Crisp,
            tint: None,
            blend,
        };
        let rgb = ImageView {
            width: 2,
            height: 1,
            format: PixelFormat::Rgb8,
            data: &[],
        };
        assert!(can_copy_row(&rgb, &op(equal, Blend::SrcOver), WHITE));
        assert!(!can_copy_row(&rgb, &op(equal, Blend::Clear), WHITE));
        assert!(!can_copy_row(
            &rgb,
            &op(
                Rect {
                    x1: 0,
                    y1: 0,
                    x2: 0,
                    y2: 0,
                },
                Blend::SrcOver
            ),
            WHITE
        ));
        let rgba = ImageView {
            width: 2,
            height: 1,
            format: PixelFormat::Rgba8,
            data: &[],
        };
        assert!(can_copy_row(&rgba, &op(equal, Blend::Src), WHITE));
        assert!(!can_copy_row(&rgba, &op(equal, Blend::SrcOver), WHITE));
        let alpha = ImageView {
            width: 2,
            height: 1,
            format: PixelFormat::Alpha8,
            data: &[],
        };
        assert!(!can_copy_row(&alpha, &op(equal, Blend::Src), WHITE));
    }

    #[test]
    fn empty_dest_is_noop() {
        let mut engine = engine_with_rgb(1, 1, &[1, 2, 3]);
        let op = Request::Blit {
            id: ImageId(1),
            dest: Rect {
                x1: 2,
                y1: 2,
                x2: 1,
                y2: 1,
            },
            src: Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            sample: Sample::Crisp,
            tint: None,
            blend: None,
            radius: None,
        };
        assert!(matches!(engine.submit(op).unwrap(), Response::None));
    }

    #[test]
    fn empty_source_is_noop_even_outside_image() {
        let mut engine = engine_with_rgb(1, 1, &[1, 2, 3]);
        let op = Request::Blit {
            id: ImageId(1),
            dest: Rect {
                x1: 0,
                y1: 0,
                x2: 0,
                y2: 0,
            },
            src: Rect {
                x1: -10,
                y1: -10,
                x2: -11,
                y2: -11,
            },
            sample: Sample::Crisp,
            tint: None,
            blend: None,
            radius: None,
        };
        assert!(matches!(engine.submit(op).unwrap(), Response::None));
    }

    #[test]
    fn clipped_out_dest_still_validates_id_and_src() {
        let mut engine = engine_with_rgb(1, 1, &[1, 2, 3]);
        engine
            .submit(Request::ClipPush {
                rect: Rect {
                    x1: 0,
                    y1: 0,
                    x2: 0,
                    y2: 0,
                },
            })
            .unwrap();

        let unknown = engine
            .submit(Request::Blit {
                id: ImageId(0),
                dest: Rect {
                    x1: 2,
                    y1: 2,
                    x2: 2,
                    y2: 2,
                },
                src: Rect {
                    x1: 0,
                    y1: 0,
                    x2: 0,
                    y2: 0,
                },
                sample: Sample::Crisp,
                tint: None,
                blend: None,
                radius: None,
            })
            .unwrap_err();
        assert_eq!(unknown, Error::UnknownImage);

        let outside = engine
            .submit(Request::Blit {
                id: ImageId(1),
                dest: Rect {
                    x1: 2,
                    y1: 2,
                    x2: 2,
                    y2: 2,
                },
                src: Rect {
                    x1: 0,
                    y1: 0,
                    x2: 1,
                    y2: 0,
                },
                sample: Sample::Crisp,
                tint: None,
                blend: None,
                radius: None,
            })
            .unwrap_err();
        assert_eq!(outside, Error::BufferLayout);
    }
}
