//! Формат дат как у System.Text.Json для UTC DateTime (ISO-8601 с миллисекундами и Z).

use chrono::{DateTime, SecondsFormat, Utc};

pub fn format_utc(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn format_utc_opt(dt: Option<DateTime<Utc>>) -> Option<String> {
    dt.map(format_utc)
}
