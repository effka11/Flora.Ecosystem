//! Однопроходный rate control v2: целевой битрейт → qp по кадрам.
//!
//! Две составляющие (обе не нормативны — декодер видит только qp в заголовке):
//! 1. **Bootstrap**: стартовый qp выводится из целевых бит на пиксель.
//!    Шаг квантования удваивается каждые +8 qp, а битрейт при прочих равных
//!    примерно пропорционален 1/step, поэтому qp ≈ QP_REF − 8·log₂(bpp/BPP_REF).
//!    Якорь калиброван по полигону (`tests/polygon.rs`, terrain/text классы).
//! 2. **Адаптация**: виртуальный буфер накапливает отклонение фактических бит
//!    от целевых; qp двигается не быстрее ±2 за кадр (без скачков), буфер
//!    подтекает (31/32) — старые ошибки забываются, смена сцены не раскачивает.
//!
//! Целочисленная арифметика — энкодер детерминирован на всех платформах.

/// Якорь калибровки: контент средней сложности при qp 32 ≈ 0.055 bpp (Q16).
const BPP_REF_Q16: i64 = 3604;
const QP_REF: i64 = 32;

/// log₂(x) в Q8 для x в Q16 (x ≥ 1). Линейная аппроксимация мантиссы,
/// |ошибка| ≤ 0.086 бита → ошибка bootstrap ≤ 0.7 qp.
fn log2_q8(x_q16: u64) -> i64 {
    debug_assert!(x_q16 > 0);
    let n = i64::from(63 - x_q16.leading_zeros()); // индекс старшего бита
    let frac = ((x_q16 << 8) >> n) as i64 - 256; // 0..=255 ≈ дробная часть
    (n - 16) * 256 + frac
}

/// Стартовый qp из целевых бит на пиксель (Q16).
fn bootstrap_qp(bpp_q16: i64) -> u8 {
    let l = log2_q8(bpp_q16.max(1) as u64) - log2_q8(BPP_REF_Q16 as u64);
    let qp_q8 = QP_REF * 256 - 8 * l;
    ((qp_q8 + 128) >> 8).clamp(0, 63) as u8
}

/// Контроллер битрейта для последовательности кадров.
#[derive(Debug, Clone)]
pub struct RateControl {
    target_bits_per_frame: i64,
    /// Накопленное отклонение в битах (положительное = перерасход).
    buffer: i64,
    qp: u8,
}

impl RateControl {
    /// `target_kbps` — целевой средний битрейт; частота кадров и размеры —
    /// для целевых бит на кадр и bootstrap-качества первого кадра.
    pub fn new(target_kbps: u32, fps_num: u32, fps_den: u32, width: u32, height: u32) -> Self {
        let fps_num = i64::from(fps_num.max(1));
        let fps_den = i64::from(fps_den.max(1));
        let target_bits = (i64::from(target_kbps) * 1000 * fps_den) / fps_num;
        let pixels = i64::from(width) * i64::from(height);
        let bpp_q16 = (target_bits << 16) / pixels.max(1);
        RateControl {
            target_bits_per_frame: target_bits.max(1),
            buffer: 0,
            qp: bootstrap_qp(bpp_q16),
        }
    }

    /// qp для текущего кадра (до скидки ключевого кадра −4 в энкодере).
    #[inline]
    pub fn qp(&self) -> u8 {
        self.qp
    }

    /// Обновление после кодирования кадра размером `frame_bytes`.
    pub fn update(&mut self, frame_bytes: usize) {
        let bits = i64::try_from(frame_bytes).unwrap_or(i64::MAX / 8) * 8;
        self.buffer += bits - self.target_bits_per_frame;

        // Заполнение буфера в кадрах перерасхода; ход qp не быстрее ±2 за кадр.
        let fill = self.buffer / self.target_bits_per_frame;
        let delta = fill.clamp(-2, 2);
        self.qp = (i64::from(self.qp) + delta).clamp(0, 63) as u8;

        // Утечка буфера: забываем старые ошибки (ключевой кадр не давит на весь GOP).
        self.buffer -= self.buffer / 32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_scales_with_target() {
        // Больше битрейт → ниже qp; экстремумы клампятся в 0..=63.
        let lo = RateControl::new(60, 30, 1, 320, 240).qp();
        let mid = RateControl::new(400, 30, 1, 320, 240).qp();
        let hi = RateControl::new(4000, 30, 1, 320, 240).qp();
        assert!(lo > mid && mid > hi, "{lo} > {mid} > {hi} expected");
        assert!(RateControl::new(1, 30, 1, 4096, 4096).qp() >= 55);
        assert!(RateControl::new(500_000, 30, 1, 64, 64).qp() == 0);
    }

    #[test]
    fn bootstrap_anchor() {
        // Точка якоря: 0.055 bpp → qp 32 (±1 на округление аппроксимации).
        // 128×96@30: 0.055 bpp = 20.3 кбит/с.
        let qp = RateControl::new(20, 30, 1, 128, 96).qp();
        assert!((31..=33).contains(&qp), "qp {qp}");
    }

    #[test]
    fn raises_qp_on_overshoot() {
        let mut rc = RateControl::new(500, 30, 1, 320, 240);
        let start = rc.qp();
        let target_bytes = (500 * 1000 / 8 / 30) as usize;
        for _ in 0..8 {
            rc.update(target_bytes * 3);
        }
        assert!(rc.qp() > start, "{} vs {start}", rc.qp());
    }

    #[test]
    fn lowers_qp_on_undershoot() {
        let mut rc = RateControl::new(500, 30, 1, 320, 240);
        let start = rc.qp();
        let target_bytes = (500 * 1000 / 8 / 30) as usize;
        for _ in 0..8 {
            rc.update(target_bytes / 20);
        }
        assert!(rc.qp() < start, "{} vs {start}", rc.qp());
    }

    #[test]
    fn qp_moves_smoothly() {
        // Слew-лимит: одно обновление сдвигает qp не более чем на 2.
        let mut rc = RateControl::new(300, 30, 1, 320, 240);
        let before = rc.qp();
        rc.update(10_000_000);
        assert!(rc.qp() <= before + 2);
    }
}
