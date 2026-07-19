//! Кусочно-линейные калибровочные кривые «сырая метрика → натуральность ‰»
//! (FPP-SIGNALS §4, Приложение A).
//!
//! Кривые — R2-параметры протокола: их точки живут в спецификации и в конфигурации,
//! ядро даёт только детерминированный вычислитель. Немонотонность разрешена
//! сознательно (пример: слишком высокое самоподобие профиля — replay-аномалия).

/// Вычислить кривую в точке `x`.
///
/// `points` — пары `(x, y‰)`, `x` строго возрастает, `y ∈ [0, 1000]`.
/// Вне диапазона — насыщение крайними `y`; между точками — линейная интерполяция
/// в `i128` с усечением к нулю. Пустая кривая → 0 (валидация параметров —
/// на границе системы, не здесь). Результат зажимается в `[0, 1000]`.
pub fn eval(points: &[(i64, u32)], x: i64) -> u32 {
    let Some(&(first_x, first_y)) = points.first() else {
        return 0;
    };
    let &(last_x, last_y) = points.last().expect("непустой список");
    if x <= first_x {
        return first_y.min(1000);
    }
    if x >= last_x {
        return last_y.min(1000);
    }
    for pair in points.windows(2) {
        let (x0, y0) = pair[0];
        let (x1, y1) = pair[1];
        if x < x1 {
            let dy = y1.min(1000) as i128 - y0.min(1000) as i128;
            let dx = x1 as i128 - x0 as i128;
            let y = y0.min(1000) as i128 + dy * (x as i128 - x0 as i128) / dx;
            return y.clamp(0, 1000) as u32;
        }
    }
    // Недостижимо при строго возрастающих x (x < last_x гарантирует сегмент).
    last_y.min(1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURVE: &[(i64, u32)] = &[(0, 1000), (100, 500), (200, 700), (300, 0)];

    #[test]
    fn saturates_outside_range() {
        assert_eq!(eval(CURVE, -50), 1000);
        assert_eq!(eval(CURVE, 0), 1000);
        assert_eq!(eval(CURVE, 300), 0);
        assert_eq!(eval(CURVE, 10_000), 0);
    }

    #[test]
    fn interpolates_with_truncation() {
        assert_eq!(eval(CURVE, 50), 750);
        // 1000 + (−500·99)/100 = 1000 − 495 (усечение к нулю: −495.0) = 505.
        assert_eq!(eval(CURVE, 99), 505);
        assert_eq!(eval(CURVE, 150), 600); // немонотонный подъём
        // 700 + (−700·99)/100 = 700 − 693 = 7.
        assert_eq!(eval(CURVE, 299), 7);
    }

    #[test]
    fn empty_and_single_point() {
        assert_eq!(eval(&[], 5), 0);
        assert_eq!(eval(&[(10, 400)], -100), 400);
        assert_eq!(eval(&[(10, 400)], 10), 400);
        assert_eq!(eval(&[(10, 400)], 100), 400);
    }

    #[test]
    fn clamps_y_above_permille() {
        assert_eq!(eval(&[(0, 5000), (10, 0)], 0), 1000);
        assert_eq!(eval(&[(0, 5000), (10, 0)], 5), 500);
    }
}
