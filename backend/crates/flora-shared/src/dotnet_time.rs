//! Паритет арифметики времени .NET: тики `DateTime` (100 нс) и `TimeSpan.TotalHours/TotalDays`.
//!
//! Формулы FIRA оперируют возрастом контента через `(nowUtc - createdAt).TotalHours/.TotalDays`.
//! В .NET 10 это `(double)_ticks / TicksPerHour` — обычное IEEE-деление (см. `TimeSpan.cs`
//! dotnet/runtime), корректно округлённое, поэтому при одинаковых тиках Rust получает
//! бит-в-бит тот же f64. Разница тиков — точная целочисленная операция в обоих рантаймах.

use chrono::{DateTime, Utc};

/// 100-наносекундных тиков в часе (`TimeSpan.TicksPerHour`).
pub const TICKS_PER_HOUR: i64 = 36_000_000_000;

/// 100-наносекундных тиков в сутках (`TimeSpan.TicksPerDay`).
pub const TICKS_PER_DAY: i64 = 864_000_000_000;

/// Разница `later − earlier` в тиках .NET (100 нс) — аналог `(later - earlier).Ticks`.
///
/// Точность источников данных (Postgres `timestamptz` — микросекунды; golden-вектора —
/// миллисекунды) кратна 100 нс, поэтому деление наносекунд на 100 точное. Интервалы
/// прикладные (возраст контента), переполнение i64-наносекунд (~292 года) недостижимо.
pub fn ticks_between(earlier: DateTime<Utc>, later: DateTime<Utc>) -> i64 {
    (later - earlier)
        .num_nanoseconds()
        .expect("интервал больше ~292 лет вне прикладной области")
        / 100
}

/// `TimeSpan.TotalHours` от разницы в тиках: `(double)ticks / TicksPerHour`.
pub fn total_hours(ticks: i64) -> f64 {
    ticks as f64 / TICKS_PER_HOUR as f64
}

/// `TimeSpan.TotalDays` от разницы в тиках: `(double)ticks / TicksPerDay`.
pub fn total_days(ticks: i64) -> f64 {
    ticks as f64 / TICKS_PER_DAY as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn exact_hours_and_days() {
        let now = utc("2026-07-13T12:00:00.000Z");
        let hour_ago = utc("2026-07-13T11:00:00.000Z");
        let month_ago = utc("2026-06-13T12:00:00.000Z");

        assert_eq!(ticks_between(hour_ago, now), TICKS_PER_HOUR);
        assert_eq!(total_hours(ticks_between(hour_ago, now)), 1.0);
        assert_eq!(total_days(ticks_between(month_ago, now)), 30.0);
    }

    #[test]
    fn negative_delta_for_future_timestamps() {
        let now = utc("2026-07-13T12:00:00.000Z");
        let future = utc("2026-07-13T14:00:00.000Z");
        assert_eq!(total_hours(ticks_between(future, now)), -2.0);
    }

    #[test]
    fn millisecond_precision_is_exact_in_ticks() {
        let a = utc("2026-07-13T12:00:00.000Z");
        let b = utc("2026-07-13T12:00:00.123Z");
        assert_eq!(ticks_between(a, b), 1_230_000);
    }
}
