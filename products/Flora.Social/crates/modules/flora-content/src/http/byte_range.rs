//! Парсинг `Range: bytes=…` — семантика как у ASP.NET FileResult (один диапазон).

/// Inclusive byte range `[start, end]` within `0..len`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

/// `Ok(None)` — отдать весь файл; `Ok(Some)` — 206; `Err(())` — 416.
pub fn parse_single_bytes_range(
    header: Option<&str>,
    total_len: u64,
) -> Result<Option<ByteRange>, ()> {
    let Some(raw) = header.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if total_len == 0 {
        return Err(());
    }
    let Some(spec) = raw.strip_prefix("bytes=") else {
        return Err(());
    };
    if spec.contains(',') {
        return Err(());
    }

    if let Some(suffix) = spec.strip_prefix('-') {
        let n: u64 = suffix.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        let start = total_len.saturating_sub(n);
        return Ok(Some(ByteRange {
            start,
            end: total_len - 1,
        }));
    }

    let (start_s, end_s) = spec.split_once('-').ok_or(())?;
    let start: u64 = start_s.parse().map_err(|_| ())?;
    if start >= total_len {
        return Err(());
    }
    let end = if end_s.is_empty() {
        total_len - 1
    } else {
        let end: u64 = end_s.parse().map_err(|_| ())?;
        end.min(total_len - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some(ByteRange { start, end }))
}
