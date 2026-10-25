//! Image store (`fgce.md` §5.3, §6, §7).
//!
//! `Rgb8` and `Rgba8` are kept premultiplied; `Alpha8` stays coverage until `Blit`.

use std::collections::HashMap;

use crate::MAX_SIDE;
use crate::color::pm;
use crate::contract::{AlphaMode, Error, ImageId, PixelFormat};

pub(crate) struct Image {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) format: PixelFormat,
    data: Vec<u8>,
    #[cfg(test)]
    allocations: usize,
}

impl Image {
    pub(crate) fn data(&self) -> &[u8] {
        &self.data
    }

    #[cfg(test)]
    pub(crate) fn rgba(&self, x: u32, y: u32) -> [u8; 4] {
        let offset = (y as usize * self.width as usize + x as usize) * 4;
        self.data[offset..offset + 4]
            .try_into()
            .expect("RGBA store row is 4 bytes per texel")
    }

    #[cfg(test)]
    pub(crate) fn coverage(&self, x: u32, y: u32) -> u8 {
        self.data[y as usize * self.width as usize + x as usize]
    }
}

pub(crate) struct Store {
    images: HashMap<ImageId, Image>,
}

impl Store {
    pub(crate) fn new() -> Self {
        Store {
            images: HashMap::new(),
        }
    }

    pub(crate) fn get(&self, id: ImageId) -> Option<&Image> {
        self.images.get(&id)
    }

    #[cfg(test)]
    pub(crate) fn image_allocations(&self) -> usize {
        self.images.values().map(|image| image.allocations).sum()
    }

    pub(crate) fn drop_image(&mut self, id: ImageId) -> Result<(), Error> {
        if id.0 == 0 || !self.images.contains_key(&id) {
            return Err(Error::UnknownImage);
        }
        self.images.remove(&id);
        Ok(())
    }
}

pub(crate) struct UploadOp<'a> {
    pub(crate) id: ImageId,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) stride: u32,
    pub(crate) format: PixelFormat,
    pub(crate) alpha: AlphaMode,
    pub(crate) bytes: &'a [u8],
}

fn input_bpp(format: PixelFormat) -> u32 {
    match format {
        PixelFormat::Rgb8 => 3,
        PixelFormat::Rgba8 => 4,
        PixelFormat::Alpha8 => 1,
    }
}

pub(crate) fn prepare(op: &UploadOp<'_>) -> Result<Image, Error> {
    let UploadOp {
        id,
        width,
        height,
        stride,
        format,
        alpha,
        bytes,
    } = *op;
    if id.0 == 0 {
        return Err(Error::UnknownImage);
    }
    if !(1..=MAX_SIDE).contains(&width) || !(1..=MAX_SIDE).contains(&height) {
        return Err(Error::ImageTooLarge);
    }
    let bpp = input_bpp(format) as u64;
    let row_bytes = width as u64 * bpp;
    if (stride as u64) < row_bytes {
        return Err(Error::BufferLayout);
    }
    let required = (height as u64 - 1) * stride as u64 + row_bytes;
    if (bytes.len() as u64) < required {
        return Err(Error::BufferLayout);
    }

    let out_bpp = if format == PixelFormat::Alpha8 { 1 } else { 4 };
    let out_row = width as usize * out_bpp;
    let mut data = Vec::with_capacity(out_row * height as usize);
    for y in 0..height as usize {
        let start = y * stride as usize;
        let row = &bytes[start..start + row_bytes as usize];
        match format {
            PixelFormat::Rgb8 => {
                for texel in row.chunks_exact(3) {
                    data.extend_from_slice(&[texel[0], texel[1], texel[2], 255]);
                }
            }
            PixelFormat::Rgba8 => match alpha {
                AlphaMode::Straight => {
                    for texel in row.chunks_exact(4) {
                        let a = texel[3];
                        data.extend_from_slice(&[
                            pm(texel[0], a),
                            pm(texel[1], a),
                            pm(texel[2], a),
                            a,
                        ]);
                    }
                }
                AlphaMode::Premul => {
                    for texel in row.chunks_exact(4) {
                        let a = texel[3];
                        if texel[0] > a || texel[1] > a || texel[2] > a {
                            return Err(Error::BufferLayout);
                        }
                    }
                    data.extend_from_slice(row);
                }
            },
            PixelFormat::Alpha8 => data.extend_from_slice(row),
        }
    }

    Ok(Image {
        width,
        height,
        format,
        data,
        #[cfg(test)]
        allocations: 1,
    })
}

pub(crate) fn insert(store: &mut Store, id: ImageId, image: Image) {
    store.images.insert(id, image);
}

#[cfg(test)]
pub(crate) fn upload(store: &mut Store, op: &UploadOp<'_>) -> Result<(), Error> {
    let image = prepare(op)?;
    insert(store, op.id, image);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op<'a>(
        id: u32,
        width: u32,
        height: u32,
        stride: u32,
        format: PixelFormat,
        alpha: AlphaMode,
        bytes: &'a [u8],
    ) -> UploadOp<'a> {
        UploadOp {
            id: ImageId(id),
            width,
            height,
            stride,
            format,
            alpha,
            bytes,
        }
    }

    fn upload_rgb(store: &mut Store, id: u32, width: u32, height: u32, pixels: &[u8]) {
        let stride = width * 3;
        upload(
            store,
            &op(
                id,
                width,
                height,
                stride,
                PixelFormat::Rgb8,
                AlphaMode::Straight,
                pixels,
            ),
        )
        .unwrap();
    }

    #[test]
    fn rgb_is_stored_premultiplied_with_opaque_alpha() {
        let mut store = Store::new();
        upload_rgb(&mut store, 1, 1, 1, &[10, 20, 30]);
        let image = store.get(ImageId(1)).unwrap();
        assert_eq!(image.rgba(0, 0), [10, 20, 30, 255]);
    }

    #[test]
    fn rgba_straight_is_premultiplied_once() {
        let mut store = Store::new();
        upload(
            &mut store,
            &op(
                1,
                1,
                1,
                4,
                PixelFormat::Rgba8,
                AlphaMode::Straight,
                &[200, 100, 50, 128],
            ),
        )
        .unwrap();
        assert_eq!(
            store.get(ImageId(1)).unwrap().rgba(0, 0),
            [100, 50, 25, 128]
        );
    }

    #[test]
    fn rgba_premul_rejects_channel_above_alpha() {
        let mut store = Store::new();
        let error = upload(
            &mut store,
            &op(
                1,
                1,
                1,
                4,
                PixelFormat::Rgba8,
                AlphaMode::Premul,
                &[101, 0, 0, 100],
            ),
        )
        .unwrap_err();
        assert_eq!(error, Error::BufferLayout);
        assert!(store.get(ImageId(1)).is_none());
    }

    #[test]
    fn alpha8_stays_coverage() {
        let mut store = Store::new();
        upload(
            &mut store,
            &op(
                1,
                2,
                1,
                2,
                PixelFormat::Alpha8,
                AlphaMode::Straight,
                &[128, 255],
            ),
        )
        .unwrap();
        let image = store.get(ImageId(1)).unwrap();
        assert_eq!(image.coverage(0, 0), 128);
        assert_eq!(image.coverage(1, 0), 255);
    }

    #[test]
    fn upload_validation() {
        let mut store = Store::new();
        assert_eq!(
            upload(
                &mut store,
                &op(0, 1, 1, 3, PixelFormat::Rgb8, AlphaMode::Straight, &[0; 3])
            )
            .unwrap_err(),
            Error::UnknownImage
        );
        assert_eq!(
            upload(
                &mut store,
                &op(1, 0, 1, 0, PixelFormat::Rgb8, AlphaMode::Straight, &[])
            )
            .unwrap_err(),
            Error::ImageTooLarge
        );
        assert_eq!(
            upload(
                &mut store,
                &op(
                    1,
                    1,
                    8193,
                    3,
                    PixelFormat::Rgb8,
                    AlphaMode::Straight,
                    &[0; 3]
                )
            )
            .unwrap_err(),
            Error::ImageTooLarge
        );
        assert_eq!(
            upload(
                &mut store,
                &op(1, 2, 1, 5, PixelFormat::Rgb8, AlphaMode::Straight, &[0; 6])
            )
            .unwrap_err(),
            Error::BufferLayout
        );
        assert_eq!(
            upload(
                &mut store,
                &op(1, 1, 2, 3, PixelFormat::Rgb8, AlphaMode::Straight, &[0; 4])
            )
            .unwrap_err(),
            Error::BufferLayout
        );
        assert!(store.get(ImageId(1)).is_none());
    }

    #[test]
    fn upload_with_stride_padding_reads_rows_only() {
        let mut store = Store::new();
        upload(
            &mut store,
            &op(
                1,
                1,
                2,
                5,
                PixelFormat::Rgb8,
                AlphaMode::Straight,
                &[1, 2, 3, 0, 0, 4, 5, 6, 0, 0],
            ),
        )
        .unwrap();
        let image = store.get(ImageId(1)).unwrap();
        assert_eq!(image.rgba(0, 0), [1, 2, 3, 255]);
        assert_eq!(image.rgba(0, 1), [4, 5, 6, 255]);
    }

    #[test]
    fn repeat_upload_replaces_and_drop_forgets() {
        let mut store = Store::new();
        upload_rgb(&mut store, 1, 1, 1, &[10, 20, 30]);
        upload_rgb(&mut store, 1, 1, 1, &[40, 50, 60]);
        assert_eq!(store.get(ImageId(1)).unwrap().rgba(0, 0), [40, 50, 60, 255]);
        store.drop_image(ImageId(1)).unwrap();
        assert!(store.get(ImageId(1)).is_none());
        assert_eq!(
            store.drop_image(ImageId(1)).unwrap_err(),
            Error::UnknownImage
        );
    }

    #[test]
    fn store_allocates_only_on_a_successful_upload() {
        let mut store = Store::new();
        assert_eq!(store.image_allocations(), 0);
        upload_rgb(&mut store, 1, 1, 1, &[1, 2, 3]);
        assert_eq!(store.image_allocations(), 1, "one image buffer per upload");
        assert_eq!(
            upload(
                &mut store,
                &op(2, 1, 1, 2, PixelFormat::Rgb8, AlphaMode::Straight, &[0; 3])
            )
            .unwrap_err(),
            Error::BufferLayout
        );
        assert_eq!(
            store.image_allocations(),
            1,
            "rejected upload allocates nothing"
        );
        store.drop_image(ImageId(1)).unwrap();
        assert_eq!(store.image_allocations(), 0, "drop releases the image");
    }
}
