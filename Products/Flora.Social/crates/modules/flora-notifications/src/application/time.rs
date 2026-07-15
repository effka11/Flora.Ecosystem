//! Формат дат как у System.Text.Json для UTC DateTime.

use chrono::{DateTime, SecondsFormat, Utc};

pub fn format_utc(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}
