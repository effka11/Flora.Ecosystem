//! Простой однопроходный rate control (v1): целевой битрейт → смещение qp по кадрам.
//!
//! Модель VBV-lite: виртуальный буфер накапливает отклонение от целевых бит/кадр;
//! переполнение повышает qp, недобор — понижает. Смещение ограничено ±12 от базового qp.
//! Не нормативно: декодер не видит rate control, только qp в заголовке кадра.

/// Контроллер битрейта для последовательности кадров.
#[derive(Debug, Clone)]
pub struct RateControl {
    base_qp: u8,
    target_bits_per_frame: i64,
    /// Накопленное отклонение в битах (положительное = перерасход).
    buffer: i64,
    qp_offset: i8,
}

impl RateControl {
    /// `target_kbps` — целевой средний битрейт; `fps_num`/`fps_den` — частота кадров.
    pub fn new(base_qp: u8, target_kbps: u32, fps_num: u32, fps_den: u32) -> Self {
        let fps_num = fps_num.max(1);
        let fps_den = fps_den.max(1);
        let target_bits = (i64::from(target_kbps) * 1000 * i64::from(fps_den)) / i64::from(fps_num);
        RateControl {
            base_qp,
            target_bits_per_frame: target_bits.max(1),
            buffer: 0,
            qp_offset: 0,
        }
    }

    /// qp для текущего кадра (до скидки ключевого кадра −4 в энкодере).
    #[inline]
    pub fn qp(&self) -> u8 {
        (i16::from(self.base_qp) + i16::from(self.qp_offset)).clamp(0, 63) as u8
    }

    /// Обновление после кодирования кадра размером `frame_bytes`.
    pub fn update(&mut self, frame_bytes: usize) {
        let bits = i64::try_from(frame_bytes).unwrap_or(i64::MAX / 8) * 8;
        self.buffer += bits - self.target_bits_per_frame;

        // Смещение qp пропорционально заполнению буфера (в долях кадра).
        let fill = self.buffer / self.target_bits_per_frame;
        self.qp_offset = fill.clamp(-48, 16) as i8;

        // Утечка буфера — адаптация к смене сцены (медленнее при сильном недоборе).
        self.buffer = self.buffer * 31 / 32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raises_qp_on_overshoot() {
        let mut rc = RateControl::new(32, 500, 30, 1);
        let target_bytes = (500 * 1000 / 8 / 30) as usize;
        for _ in 0..8 {
            rc.update(target_bytes * 2);
        }
        assert!(rc.qp() > 32);
    }

    #[test]
    fn lowers_qp_on_undershoot() {
        let mut rc = RateControl::new(40, 500, 30, 1);
        let target_bytes = (500 * 1000 / 8 / 30) as usize;
        for _ in 0..6 {
            rc.update(target_bytes / 20);
        }
        assert!(rc.qp() < 40);
    }
}
