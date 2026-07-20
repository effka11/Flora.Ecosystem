//! Отдача bytea-медиа (images / avatars / videos) — паритет `GetPostImage`, `GetAvatar`, `GetPostVideo`.

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;

use crate::http::byte_range::parse_single_bytes_range;

const CACHE_IMMUTABLE: &str = "public, max-age=31536000";
const CACHE_REVALIDATE: &str = "public, max-age=0, must-revalidate";
const CACHE_PRIVATE: &str = "private, no-store, max-age=0";

#[derive(Clone, Copy)]
pub enum MediaCache {
    PublicImmutable,
    PublicRevalidate,
    PrivateNoStore,
}

impl MediaCache {
    fn header_value(self) -> &'static str {
        match self {
            Self::PublicImmutable => CACHE_IMMUTABLE,
            Self::PublicRevalidate => CACHE_REVALIDATE,
            Self::PrivateNoStore => CACHE_PRIVATE,
        }
    }
}

pub fn cached_media_response(data: Vec<u8>, content_type: &str, cache: MediaCache) -> Response {
    let mut res = Response::new(Body::from(data));
    *res.status_mut() = StatusCode::OK;
    if let Ok(v) = HeaderValue::from_str(content_type) {
        res.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    if let Ok(v) = HeaderValue::from_str(cache.header_value()) {
        res.headers_mut().insert(header::CACHE_CONTROL, v);
    }
    res.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    res
}

/// Паритет с `File(..., enableRangeProcessing: true)`.
pub fn cached_ranged_media_response(
    data: Vec<u8>,
    content_type: &str,
    headers: &HeaderMap,
    cache: MediaCache,
) -> Response {
    let total = data.len() as u64;
    let range_hdr = headers.get(header::RANGE).and_then(|v| v.to_str().ok());

    match parse_single_bytes_range(range_hdr, total) {
        Ok(None) => {
            let mut res = cached_media_response(data, content_type, cache);
            res.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            res
        }
        Ok(Some(r)) => {
            let start = r.start as usize;
            let end_excl = (r.end as usize) + 1;
            let slice = data[start..end_excl].to_vec();
            let mut res = Response::new(Body::from(slice));
            *res.status_mut() = StatusCode::PARTIAL_CONTENT;
            if let Ok(v) = HeaderValue::from_str(content_type) {
                res.headers_mut().insert(header::CONTENT_TYPE, v);
            }
            if let Ok(v) = HeaderValue::from_str(cache.header_value()) {
                res.headers_mut().insert(header::CACHE_CONTROL, v);
            }
            res.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            res.headers_mut().insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            let content_range = format!("bytes {}-{}/{}", r.start, r.end, total);
            if let Ok(v) = HeaderValue::from_str(&content_range) {
                res.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            res
        }
        Err(()) => {
            let mut res = Response::new(Body::empty());
            *res.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            res.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            let content_range = format!("bytes */{total}");
            if let Ok(v) = HeaderValue::from_str(&content_range) {
                res.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            res
        }
    }
}
