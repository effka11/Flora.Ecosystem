//! Cursor keyset: base64url(UTF8("{dotnet_ticks}")) — паритет `ConversationService` (C#).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};

/// Тики Unix-эпохи в шкале `DateTime.Ticks` (.NET).
const DOTNET_UNIX_EPOCH_TICKS: i64 = 621_355_968_000_000_000;

pub fn encode_cursor(at: DateTime<Utc>) -> String {
    let ticks = to_dotnet_ticks(at);
    URL_SAFE_NO_PAD.encode(ticks.to_string().as_bytes())
}

pub fn decode_cursor(cursor: Option<&str>) -> Option<DateTime<Utc>> {
    let cursor = cursor.filter(|s| !s.is_empty())?;
    let padded = pad_b64(cursor);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(padded.as_bytes())
        .ok()?;
    let text = std::str::from_utf8(&bytes).ok()?;
    let ticks: i64 = text.parse().ok()?;
    from_dotnet_ticks(ticks)
}

fn pad_b64(s: &str) -> String {
    let mut t = s.replace('-', "+").replace('_', "/");
    let pad = (4 - t.len() % 4) % 4;
    t.extend(std::iter::repeat_n('=', pad));
    t
}

fn to_dotnet_ticks(dt: DateTime<Utc>) -> i64 {
    let nanos = dt.timestamp_nanos_opt().unwrap_or(0);
    nanos / 100 + DOTNET_UNIX_EPOCH_TICKS
}

fn from_dotnet_ticks(ticks: i64) -> Option<DateTime<Utc>> {
    let unix_nanos = ticks
        .checked_sub(DOTNET_UNIX_EPOCH_TICKS)?
        .checked_mul(100)?;
    DateTime::from_timestamp(
        unix_nanos.div_euclid(1_000_000_000),
        u32::try_from(unix_nanos.rem_euclid(1_000_000_000)).ok()?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_roundtrip() {
        let at = DateTime::parse_from_rfc3339("2026-07-13T12:00:00.123Z")
            .unwrap()
            .with_timezone(&Utc);
        let enc = encode_cursor(at);
        let dec = decode_cursor(Some(&enc)).expect("decode");
        assert_eq!(dec, at);
    }
}
