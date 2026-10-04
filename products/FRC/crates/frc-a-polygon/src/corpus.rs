//! Детерминированный синтетический корпус полигона FRC-A.
//!
//! Репозиторий не хранит бинарные аудио-ассеты (правило FRC-A.md), поэтому
//! корпус генерируется процедурно и полностью детерминирован: одинаковые
//! сэмплы на всех платформах данной сборки. Классы покрывают известные
//! codec-killer сценарии: речь (форманты + фрикативы + паузы), кастаньеты
//! (pre-echo), аплодисменты (плотные транзиенты + шум), клавесин/глокеншпиль
//! (атаки с гармонической/негармонической структурой), пэды (стационарная
//! тональность), EDM (бас + кик + хэты), свипы/мультитоны, шумы, стерео-кейсы
//! (широкий образ, жёсткое панорамирование) и краевые случаи (тишина, стресс).

use core::f64::consts::PI;

/// Класс сигнала — группировка кейсов в отчёте и выбор сетки битрейтов.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Speech,
    Transient,
    Music,
    Noise,
    Stereo,
    Synthetic,
    Edge,
}

impl Class {
    pub fn as_str(self) -> &'static str {
        match self {
            Class::Speech => "speech",
            Class::Transient => "transient",
            Class::Music => "music",
            Class::Noise => "noise",
            Class::Stereo => "stereo",
            Class::Synthetic => "synthetic",
            Class::Edge => "edge",
        }
    }
}

pub struct CorpusItem {
    pub name: &'static str,
    pub class: Class,
    pub sample_rate: u32,
    pub channels: u8,
    /// PCM f32 interleaved, пики ≤ 0.95.
    pub pcm: Vec<f32>,
}

/// Полный корпус в фиксированном порядке.
pub fn full_corpus() -> Vec<CorpusItem> {
    vec![
        speech_like("speech_male_48k", 48_000, 110.0, 0x51EE_C401),
        speech_like("speech_female_48k", 48_000, 205.0, 0x51EE_C402),
        speech_like("speech_male_44k1", 44_100, 118.0, 0x51EE_C403),
        castanets("castanets_48k"),
        applause("applause_48k"),
        harpsichord("harpsichord_48k"),
        glockenspiel("glockenspiel_48k"),
        pad_chord("pad_chord_48k", false),
        edm("edm_48k"),
        legacy_mix("legacy_mix_48k"),
        sweep_log("sweep_log_48k"),
        multitone("multitone_48k"),
        white_noise_item("white_noise_48k"),
        pink_noise_item("pink_noise_48k"),
        pad_chord("stereo_wide_pad_48k", true),
        panned_clicks("stereo_panned_clicks_48k"),
        near_silence("near_silence_48k"),
        stress_dense("stress_dense_48k"),
    ]
}

pub fn by_name(name: &str) -> Option<CorpusItem> {
    full_corpus().into_iter().find(|i| i.name == name)
}

// ---------- DSP-инструменты (детерминированные) ----------

/// xorshift32 — общий детерминированный ГПСЧ корпуса.
struct Rng(u32);

impl Rng {
    fn next_u32(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }

    /// Равномерное в [−1, 1).
    fn bipolar(&mut self) -> f32 {
        (self.next_u32() as f32 / 2f32.powi(31)) - 1.0
    }

    /// Равномерное в [0, 1).
    fn unit(&mut self) -> f32 {
        self.next_u32() as f32 / 2f32.powi(32)
    }

    /// Равномерное в [lo, hi).
    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.unit()
    }
}

/// Биквад RBJ (Direct Form I) — резонаторы формант и полосовые фильтры.
#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    /// Полосовой с постоянным пиковым усилением (RBJ BPF, peak gain = Q).
    fn bandpass(rate: f32, f0: f32, q: f32) -> Self {
        let w0 = 2.0 * PI as f32 * (f0 / rate).min(0.49);
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: alpha / a0,
            b1: 0.0,
            b2: -alpha / a0,
            a1: -2.0 * w0.cos() / a0,
            a2: (1.0 - alpha) / a0,
            ..Self::default()
        }
    }

    fn highpass(rate: f32, f0: f32, q: f32) -> Self {
        let w0 = 2.0 * PI as f32 * (f0 / rate).min(0.49);
        let (sin, cos) = (w0.sin(), w0.cos());
        let alpha = sin / (2.0 * q);
        let a0 = 1.0 + alpha;
        let b = (1.0 + cos) / 2.0;
        Self {
            b0: b / a0,
            b1: -2.0 * b / a0,
            b2: b / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
            ..Self::default()
        }
    }

    fn lowpass(rate: f32, f0: f32, q: f32) -> Self {
        let w0 = 2.0 * PI as f32 * (f0 / rate).min(0.49);
        let (sin, cos) = (w0.sin(), w0.cos());
        let alpha = sin / (2.0 * q);
        let a0 = 1.0 + alpha;
        let b = (1.0 - cos) / 2.0;
        Self {
            b0: b / a0,
            b1: 2.0 * b / a0,
            b2: b / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
            ..Self::default()
        }
    }

    /// Обновить коэффициенты, сохранив состояние линии задержки.
    fn retune(&mut self, fresh: Biquad) {
        self.b0 = fresh.b0;
        self.b1 = fresh.b1;
        self.b2 = fresh.b2;
        self.a1 = fresh.a1;
        self.a2 = fresh.a2;
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Розовый шум — фильтр Пола Келлета (−3 дБ/окт аппроксимация).
struct Pink {
    b: [f32; 6],
}

impl Pink {
    fn new() -> Self {
        Self { b: [0.0; 6] }
    }

    fn process(&mut self, white: f32) -> f32 {
        let b = &mut self.b;
        b[0] = 0.99886 * b[0] + white * 0.055_517_9;
        b[1] = 0.99332 * b[1] + white * 0.075_075_9;
        b[2] = 0.96900 * b[2] + white * 0.153_852;
        b[3] = 0.86650 * b[3] + white * 0.310_485_6;
        b[4] = 0.55000 * b[4] + white * 0.533_952_4;
        b[5] = -0.7616 * b[5] - white * 0.016_898_0;
        (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + white * 0.5362) * 0.11
    }
}

/// Нормализация: если пик выше цели — привести к ней (тихие кейсы не трогаем).
fn normalize_peak(pcm: &mut [f32], target: f32) {
    let peak = pcm.iter().fold(0f32, |m, &v| m.max(v.abs()));
    if peak > target {
        let k = target / peak;
        for v in pcm.iter_mut() {
            *v *= k;
        }
    }
}

fn total_samples(rate: u32, secs: f32) -> usize {
    (secs * rate as f32) as usize
}

// ---------- Речь ----------

/// Форманты гласных (F1, F2, F3) и их полосы — классические средние значения.
const VOWELS: [([f32; 3], [f32; 3]); 5] = [
    ([730.0, 1090.0, 2440.0], [90.0, 110.0, 170.0]), // /a/
    ([530.0, 1840.0, 2480.0], [80.0, 120.0, 180.0]), // /e/
    ([270.0, 2290.0, 3010.0], [60.0, 100.0, 190.0]), // /i/
    ([570.0, 840.0, 2410.0], [80.0, 100.0, 170.0]),  // /o/
    ([300.0, 870.0, 2240.0], [60.0, 90.0, 170.0]),   // /u/
];

/// Речеподобный сигнал: гармонический источник (пульс голосовой щели с
/// наклоном −6 дБ/окт), три формантных резонатора с морфингом гласных,
/// фрикативные согласные (шум через HP), взрывные onset'ы, слоговый ритм,
/// деклинация и вибрато F0, паузы между фразами.
fn speech_like(name: &'static str, rate: u32, f0_base: f32, seed: u32) -> CorpusItem {
    let secs = 6.0f32;
    let total = total_samples(rate, secs);
    let mut rng = Rng(seed);
    let mut out = vec![0f32; total];

    // Слоговая структура: [onset-шум?][гласная 120–260 мс], фразы по 5–8
    // слогов, паузы 150–350 мс.
    struct Syllable {
        start: usize,
        voiced_len: usize,
        onset_len: usize,
        vowel: usize,
        next_vowel: usize,
        stress: f32,
    }
    let mut syllables = Vec::new();
    let mut pos = (0.06 * rate as f32) as usize;
    let mut phrase_left = 5 + (rng.next_u32() % 4) as usize;
    while pos < total {
        let onset_len = if rng.unit() < 0.55 {
            (rng.range(0.012, 0.03) * rate as f32) as usize
        } else {
            0
        };
        let voiced_len = (rng.range(0.12, 0.26) * rate as f32) as usize;
        let vowel = (rng.next_u32() % 5) as usize;
        syllables.push(Syllable {
            start: pos,
            voiced_len,
            onset_len,
            vowel,
            next_vowel: (rng.next_u32() % 5) as usize,
            stress: rng.range(0.55, 1.0),
        });
        pos += onset_len + voiced_len + (rng.range(0.01, 0.05) * rate as f32) as usize;
        phrase_left -= 1;
        if phrase_left == 0 {
            pos += (rng.range(0.15, 0.35) * rate as f32) as usize;
            phrase_left = 5 + (rng.next_u32() % 4) as usize;
        }
    }

    let mut formants = [
        Biquad::bandpass(rate as f32, 700.0, 8.0),
        Biquad::bandpass(rate as f32, 1100.0, 10.0),
        Biquad::bandpass(rate as f32, 2400.0, 12.0),
    ];
    let mut fric_hp = Biquad::highpass(rate as f32, 2800.0, 0.7);
    let mut fric_bp = Biquad::bandpass(rate as f32, 5200.0, 1.2);
    let mut tilt = Biquad::lowpass(rate as f32, 3500.0, 0.6);

    let mut phase = 0f64;
    let mut jitter = 0f32;
    let retune_step = (rate / 200).max(1) as usize; // каждые 5 мс

    for syl in &syllables {
        // Взрывной/фрикативный onset: шумовой всплеск перед гласной.
        for i in 0..syl.onset_len {
            let idx = syl.start + i;
            if idx >= total {
                break;
            }
            let env = {
                let x = i as f32 / syl.onset_len.max(1) as f32;
                (1.0 - x).powi(2)
            };
            let n = fric_bp.process(fric_hp.process(rng.bipolar()));
            out[idx] += 0.55 * syl.stress * env * n;
        }

        // Гласная: гармонический источник через морфящиеся форманты.
        let vstart = syl.start + syl.onset_len;
        for i in 0..syl.voiced_len {
            let idx = vstart + i;
            if idx >= total {
                break;
            }
            let x = i as f32 / syl.voiced_len as f32;
            let t_abs = idx as f32 / total as f32;
            // F0: деклинация по фразе + вибрато + джиттер (случайное блуждание).
            jitter = 0.995 * jitter + 0.0025 * rng.bipolar();
            let vib = 1.0 + 0.018 * (2.0 * PI as f32 * 5.3 * idx as f32 / rate as f32).sin();
            let f0 = f0_base * (1.05 - 0.18 * t_abs) * vib * (1.0 + jitter) * syl.stress.sqrt();

            // Морфинг формант каждые 5 мс.
            if i % retune_step == 0 {
                let (fa, ba) = VOWELS[syl.vowel];
                let (fb, bb) = VOWELS[syl.next_vowel];
                let m = (x * 1.4).min(1.0);
                for (k, f) in formants.iter_mut().enumerate() {
                    let fc = fa[k] + (fb[k] - fa[k]) * m;
                    let bw = ba[k] + (bb[k] - ba[k]) * m;
                    f.retune(Biquad::bandpass(
                        rate as f32,
                        fc,
                        (fc / bw).clamp(2.0, 16.0),
                    ));
                }
            }

            // Источник: band-limited пульс (гармоники с наклоном 1/h).
            phase += f64::from(f0) / f64::from(rate);
            if phase >= 1.0 {
                phase -= 1.0;
            }
            let nyq_h = (f64::from(rate) * 0.45 / f64::from(f0)) as usize;
            let mut src = 0f32;
            let mut h = 1usize;
            while h <= nyq_h.min(48) {
                src += ((2.0 * PI * phase * h as f64).sin() / h as f64) as f32;
                h += 1;
            }
            // Придыхание: лёгкий шумовой компонент в источнике.
            src += 0.06 * rng.bipolar();

            let env = syllable_env(x);
            let f_sum: f32 = formants
                .iter_mut()
                .zip([1.0f32, 0.7, 0.4])
                .map(|(f, g)| g * f.process(src))
                .sum();
            let sample = tilt.process(f_sum + 0.12 * src);
            out[idx] += 0.9 * syl.stress * env * sample;
        }
    }

    normalize_peak(&mut out, 0.85);
    CorpusItem {
        name,
        class: Class::Speech,
        sample_rate: rate,
        channels: 1,
        pcm: out,
    }
}

/// Огибающая слога: атака 12%, плато, спад 25%.
fn syllable_env(x: f32) -> f32 {
    if x < 0.12 {
        x / 0.12
    } else if x > 0.75 {
        ((1.0 - x) / 0.25).max(0.0)
    } else {
        1.0
    }
}

// ---------- Транзиенты ----------

/// Кастаньеты: резкие широкополосные щелчки (атака мгновенная, спад ~2 мс)
/// с дублями-«трелями», между ними почти тишина. Главный pre-echo материал.
fn castanets(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 4.0);
    let mut rng = Rng(0xCA57_A9E7);
    let mut out = vec![0f32; total];
    let mut bp = Biquad::bandpass(rate as f32, 3200.0, 0.9);
    let mut pos = (0.15 * rate as f32) as usize;
    while pos < total {
        let clicks = if rng.unit() < 0.4 { 2 } else { 1 };
        for c in 0..clicks {
            let start = pos + c * (rng.range(0.028, 0.05) * rate as f32) as usize;
            let len = (rng.range(0.002, 0.004) * rate as f32) as usize;
            let amp = rng.range(0.55, 0.9);
            for i in 0..len {
                let idx = start + i;
                if idx >= total {
                    break;
                }
                let env = (-(i as f32) / (0.0015 * rate as f32)).exp();
                out[idx] += amp * env * bp.process(rng.bipolar());
            }
        }
        pos += (rng.range(0.18, 0.42) * rate as f32) as usize;
    }
    normalize_peak(&mut out, 0.9);
    CorpusItem {
        name,
        class: Class::Transient,
        sample_rate: rate,
        channels: 1,
        pcm: out,
    }
}

/// Аплодисменты: пуассоновский поток коротких хлопков (полосовой шум 1.5–3 мс)
/// со случайной панорамой + шумовая «подушка» зала. Классический codec-killer.
fn applause(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 4.0);
    let mut rng = Rng(0xA991_AB5E);
    let mut out = vec![0f32; total * 2];
    let mut bed_pink = Pink::new();
    let mut clap_bp = Biquad::bandpass(rate as f32, 1800.0, 0.8);

    // Подушка зала.
    for j in 0..total {
        let n = 0.05 * bed_pink.process(rng.bipolar());
        out[2 * j] += n;
        out[2 * j + 1] += n * 0.9 + 0.01 * rng.bipolar();
    }
    // Хлопки: средняя плотность ~35/с (экспоненциальные интервалы).
    let mut t = 0f32;
    loop {
        t += -rng.unit().max(1e-6).ln() / 35.0;
        let start = (t * rate as f32) as usize;
        if start >= total {
            break;
        }
        let len = (rng.range(0.0015, 0.0035) * rate as f32) as usize;
        let amp = rng.range(0.12, 0.5);
        let pan = rng.unit(); // 0 = L, 1 = R
        for i in 0..len {
            let idx = start + i;
            if idx >= total {
                break;
            }
            let env = (-(i as f32) / (0.001 * rate as f32)).exp();
            let s = amp * env * clap_bp.process(rng.bipolar());
            out[2 * idx] += s * (1.0 - pan).sqrt();
            out[2 * idx + 1] += s * pan.sqrt();
        }
    }
    normalize_peak(&mut out, 0.9);
    CorpusItem {
        name,
        class: Class::Transient,
        sample_rate: rate,
        channels: 2,
        pcm: out,
    }
}

/// Клавесин: щипковые струны Карплуса–Стронга, быстрое арпеджио, богатые ВЧ.
fn harpsichord(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 4.0);
    let mut rng = Rng(0x4A99_51C0);
    let mut out = vec![0f32; total];
    // Ля-минорное арпеджио через две октавы, шестнадцатые ~125 мс.
    let midi_pattern = [
        57, 60, 64, 69, 72, 76, 72, 69, 64, 60, 57, 60, 64, 69, 72, 76,
    ];
    let note_step = (0.125 * rate as f32) as usize;
    let mut note_idx = 0usize;
    let mut pos = 0usize;
    while pos < total {
        let midi = midi_pattern[note_idx % midi_pattern.len()];
        let f0 = 440.0 * 2f32.powf((midi as f32 - 69.0) / 12.0);
        let period = (rate as f32 / f0) as usize;
        // Струна Карплуса–Стронга: шумовое заполнение, петля с усреднением.
        let mut string = vec![0f32; period];
        for v in string.iter_mut() {
            *v = rng.bipolar();
        }
        let dur = (1.4 * rate as f32) as usize;
        let mut prev = 0f32;
        for i in 0..dur {
            let idx = pos + i;
            if idx >= total {
                break;
            }
            let cur = string[i % period];
            let next = 0.997 * 0.5 * (cur + prev);
            prev = cur;
            string[i % period] = next;
            // Атака подчёркнута: первые 4 мс струна звучит громче.
            let atk = if i < (0.004 * rate as f32) as usize {
                1.6
            } else {
                1.0
            };
            out[idx] += 0.5 * atk * cur;
        }
        pos += note_step;
        note_idx += 1;
    }
    normalize_peak(&mut out, 0.9);
    CorpusItem {
        name,
        class: Class::Transient,
        sample_rate: rate,
        channels: 1,
        pcm: out,
    }
}

/// Глокеншпиль: редкие удары с негармоническими парциалами бруска
/// (1 : 2.76 : 5.40 : 8.93) и долгим звенящим спадом на тихом фоне.
fn glockenspiel(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 4.0);
    let mut rng = Rng(0x910C_7E11);
    let mut out = vec![0f32; total];
    const PARTIALS: [f32; 4] = [1.0, 2.756, 5.404, 8.933];
    let notes = [880.0f32, 1174.7, 987.8, 1318.5, 1046.5, 1568.0];
    let mut pos = (0.1 * 48_000f32) as usize;
    let mut n = 0usize;
    while pos < total {
        let f0 = notes[n % notes.len()];
        let amp = rng.range(0.35, 0.6);
        let dur = (2.2 * rate as f32) as usize;
        for (k, &ratio) in PARTIALS.iter().enumerate() {
            let f = f0 * ratio;
            if f > rate as f32 * 0.45 {
                continue;
            }
            let decay = 1.8 / (1.0 + k as f32 * 1.2); // высшие парциалы гаснут быстрее
            let g = amp / (1.0 + k as f32);
            let mut phase = f64::from(rng.unit());
            for i in 0..dur {
                let idx = pos + i;
                if idx >= total {
                    break;
                }
                let t = i as f32 / rate as f32;
                let env = (-t / decay).exp() * (1.0 - (-(t) / 0.001).exp());
                phase += f64::from(f) / f64::from(rate);
                out[idx] += g * env * ((2.0 * PI * phase).sin() as f32);
            }
        }
        pos += (rng.range(0.5, 0.75) * rate as f32) as usize;
        n += 1;
    }
    normalize_peak(&mut out, 0.85);
    CorpusItem {
        name,
        class: Class::Transient,
        sample_rate: rate,
        channels: 1,
        pcm: out,
    }
}

// ---------- Музыка ----------

/// Пэд: аддитивный аккорд (4 ноты × 6 парциалов) с медленными LFO амплитуд
/// и биениями расстройки. `wide = true` — стерео с декоррелированными
/// фазами/расстройкой (широкий образ, большая side-энергия).
fn pad_chord(name: &'static str, wide: bool) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 4.0);
    let ch = if wide { 2usize } else { 1 };
    let mut rng = Rng(0x9AD_C08D);
    let notes = [130.81f32, 164.81, 196.0, 246.94]; // Cmaj7
    let mut out = vec![0f32; total * ch];

    struct Partial {
        freq: f64,
        amp: f32,
        lfo_rate: f32,
        lfo_phase: f32,
        phase: [f64; 2],
        pan: f32,
    }
    let mut partials = Vec::new();
    for &note in &notes {
        for h in 1..=6u32 {
            let detune = 1.0 + 0.0004 * rng.bipolar();
            partials.push(Partial {
                freq: f64::from(note * h as f32 * detune),
                amp: 0.22 / h as f32,
                lfo_rate: rng.range(0.07, 0.5),
                lfo_phase: rng.unit(),
                phase: [f64::from(rng.unit()), f64::from(rng.unit())],
                pan: if wide { rng.unit() } else { 0.5 },
            });
        }
    }
    for j in 0..total {
        let t = j as f32 / rate as f32;
        let mut acc = [0f32; 2];
        for p in partials.iter_mut() {
            let lfo = 0.65 + 0.35 * (2.0 * PI as f32 * (p.lfo_rate * t + p.lfo_phase)).sin();
            for (c, a) in acc.iter_mut().enumerate().take(ch) {
                // В широком режиме правый канал слегка расстроен — декорреляция.
                let detune: f64 = if wide && c == 1 { 1.0008 } else { 1.0 };
                p.phase[c] += p.freq * detune / f64::from(rate);
                let g = if c == 0 {
                    (1.0 - p.pan).sqrt()
                } else {
                    p.pan.sqrt()
                };
                *a += p.amp * lfo * g * ((2.0 * PI * p.phase[c]).sin() as f32);
            }
        }
        for c in 0..ch {
            out[j * ch + c] = acc[c];
        }
    }
    normalize_peak(&mut out, 0.8);
    CorpusItem {
        name,
        class: if wide { Class::Stereo } else { Class::Music },
        sample_rate: rate,
        channels: ch as u8,
        pcm: out,
    }
}

/// EDM-подобный микс: кик (свип 80→45 Гц + клик), сайдчейн-суб 55 Гц,
/// хэты восьмыми, оффбит-стабы (band-limited saw). Бас + транзиенты.
fn edm(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 4.0);
    let mut rng = Rng(0xEDA_0BEA7);
    let mut out = vec![0f32; total];
    let beat = (0.5 * rate as f32) as usize; // 120 BPM

    let mut sub_phase = 0f64;
    let mut stab_phases = [0f64; 6];
    for (j, o) in out.iter_mut().enumerate() {
        let in_beat = j % beat;
        let tb = in_beat as f32 / rate as f32;

        // Кик: экспоненциальный свип частоты и амплитуды + щелчок атаки.
        let mut s = 0f32;
        if tb < 0.16 {
            let f = 45.0 + 35.0 * (-tb / 0.03).exp();
            let env = (-tb / 0.09).exp();
            let ph = 2.0 * PI as f32 * f * tb
                - 2.0 * PI as f32 * 35.0 * 0.03 * (1.0 - (-tb / 0.03).exp());
            s += 0.85 * env * ph.sin();
            if in_beat < 48 {
                s += 0.4 * (1.0 - in_beat as f32 / 48.0) * rng.bipolar();
            }
        }
        // Суб-бас с сайдчейном (приглушается на первые 150 мс бита).
        sub_phase += 55.0 / f64::from(rate);
        let duck = if tb < 0.15 { tb / 0.15 } else { 1.0 };
        s += 0.4 * duck * ((2.0 * PI * sub_phase).sin() as f32);
        // Хэты восьмыми: HP-шум 25 мс.
        let eighth = beat / 2;
        let in_e = j % eighth;
        if in_e < (0.025 * rate as f32) as usize {
            let env = (-(in_e as f32) / (0.006 * rate as f32)).exp();
            s += 0.22 * env * rng.bipolar();
        }
        // Оффбит-стаб: пилообразный аккорд 100 мс на слабой доле.
        if in_beat >= beat / 2 && in_beat < beat / 2 + (0.1 * rate as f32) as usize {
            let x = (in_beat - beat / 2) as f32 / (0.1 * rate as f32);
            let env = (1.0 - x).powi(2);
            for (k, ph) in stab_phases.iter_mut().enumerate() {
                let f = 220.0 * (1.0 + k as f64 * 0.5); // квинтовый стек
                *ph += f / f64::from(rate);
                let mut saw = 0f32;
                for h in 1..=10u32 {
                    if f * f64::from(h) < f64::from(rate) * 0.45 {
                        saw += ((2.0 * PI * *ph * f64::from(h)).sin() / f64::from(h)) as f32;
                    }
                }
                s += 0.08 * env * saw;
            }
        }
        *o = s;
    }
    normalize_peak(&mut out, 0.9);
    CorpusItem {
        name,
        class: Class::Music,
        sample_rate: rate,
        channels: 1,
        pcm: out,
    }
}

/// Исторический mix-сигнал из интеграционных тестов ядра — непрерывность
/// сравнений между версиями кодека.
fn legacy_mix(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let ch = 2usize;
    let total = total_samples(rate, 3.0);
    let mut out = Vec::with_capacity(total * ch);
    let mut rng = Rng(0x1357_9BDF);
    let mut lp = [0f32; 2];
    for j in 0..total {
        let t = j as f32 / rate as f32;
        let trem = 0.7 + 0.3 * (2.0 * PI as f32 * 3.0 * t).sin();
        for (c, lp_c) in lp.iter_mut().enumerate().take(ch) {
            let det = 1.0 + 0.001 * c as f32;
            let chord = 0.30 * (2.0 * PI as f32 * 220.0 * det * t).sin()
                + 0.22 * (2.0 * PI as f32 * 277.18 * det * t).sin()
                + 0.18 * (2.0 * PI as f32 * 329.63 * det * t + c as f32).sin();
            *lp_c = 0.85 * *lp_c + 0.15 * rng.bipolar();
            let click_phase = j % (rate as usize / 2);
            let click = if click_phase < 240 {
                0.35 * rng.bipolar() * (-(click_phase as f32) / 40.0).exp()
            } else {
                0.0
            };
            out.push((chord * trem + 0.10 * *lp_c + click).clamp(-0.95, 0.95));
        }
    }
    CorpusItem {
        name,
        class: Class::Music,
        sample_rate: rate,
        channels: 2,
        pcm: out,
    }
}

// ---------- Синтетика ----------

/// Логарифмический свип 30 Гц → 20 кГц.
fn sweep_log(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let secs = 3.0f32;
    let total = total_samples(rate, secs);
    let mut out = vec![0f32; total];
    let mut phase = 0f64;
    for (j, v) in out.iter_mut().enumerate() {
        let x = j as f64 / total as f64;
        let f = 30.0 * (20_000.0f64 / 30.0).powf(x);
        phase += f / f64::from(rate);
        *v = 0.5 * (2.0 * PI * phase).sin() as f32;
    }
    CorpusItem {
        name,
        class: Class::Synthetic,
        sample_rate: rate,
        channels: 1,
        pcm: out,
    }
}

/// 10 логарифмически расставленных тонов 100 Гц … 12.8 кГц одновременно.
fn multitone(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 2.0);
    let mut out = vec![0f32; total];
    let mut rng = Rng(0x0107_0AE5);
    let phases: Vec<f64> = (0..10).map(|_| f64::from(rng.unit())).collect();
    for (j, v) in out.iter_mut().enumerate() {
        let t = j as f64 / f64::from(rate);
        let mut s = 0f64;
        for (k, ph) in phases.iter().enumerate() {
            let f = 100.0 * 2f64.powf(k as f64 * 0.7);
            s += 0.08 * (2.0 * PI * (f * t + ph)).sin();
        }
        *v = s as f32;
    }
    CorpusItem {
        name,
        class: Class::Synthetic,
        sample_rate: rate,
        channels: 1,
        pcm: out,
    }
}

fn white_noise_item(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 2.0);
    let mut rng = Rng(0xDEAD_BEEF);
    let pcm: Vec<f32> = (0..total * 2).map(|_| 0.3 * rng.bipolar()).collect();
    CorpusItem {
        name,
        class: Class::Noise,
        sample_rate: rate,
        channels: 2,
        pcm,
    }
}

fn pink_noise_item(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 3.0);
    let mut rng = Rng(0x0991_C0DE);
    let mut pink = Pink::new();
    let pcm: Vec<f32> = (0..total)
        .map(|_| 0.5 * pink.process(rng.bipolar()))
        .collect();
    CorpusItem {
        name,
        class: Class::Noise,
        sample_rate: rate,
        channels: 1,
        pcm,
    }
}

// ---------- Стерео и краевые ----------

/// Щелчковый поезд с жёстким чередованием панорамы L/R — стерео-транзиенты
/// и anti-collapse в M/S-домене.
fn panned_clicks(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 3.0);
    let mut rng = Rng(0x9A44_ED01);
    let mut out = vec![0f32; total * 2];
    // Тихий фон, чтобы кадры не были цифровой тишиной.
    let mut pink = Pink::new();
    for j in 0..total {
        let n = 0.03 * pink.process(rng.bipolar());
        out[2 * j] += n;
        out[2 * j + 1] += n;
    }
    let step = (0.125 * rate as f32) as usize;
    let mut left = true;
    let mut pos = step / 2;
    while pos < total {
        let len = (0.003 * rate as f32) as usize;
        for i in 0..len {
            let idx = pos + i;
            if idx >= total {
                break;
            }
            let env = (-(i as f32) / (0.001 * rate as f32)).exp();
            let s = 0.8 * env * rng.bipolar();
            out[2 * idx + usize::from(!left)] += s;
        }
        left = !left;
        pos += step;
    }
    normalize_peak(&mut out, 0.9);
    CorpusItem {
        name,
        class: Class::Stereo,
        sample_rate: rate,
        channels: 2,
        pcm: out,
    }
}

/// Почти тишина: шумовой пол −80 дБFS + редкий тон −60 дБFS. Проверяет
/// параметрический режим, шумозаполнение и отсутствие «раздувания» тишины.
fn near_silence(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 2.0);
    let mut rng = Rng(0x0051_1E4C);
    let mut out = vec![0f32; total];
    for (j, v) in out.iter_mut().enumerate() {
        let t = j as f32 / rate as f32;
        *v = 1e-4 * rng.bipolar()
            + if (0.8..1.4).contains(&t) {
                1e-3 * (2.0 * PI as f32 * 620.0 * t).sin()
            } else {
                0.0
            };
    }
    CorpusItem {
        name,
        class: Class::Edge,
        sample_rate: rate,
        channels: 1,
        pcm: out,
    }
}

/// Стресс: плотный полный спектр на почти полной шкале — широкополосные
/// аккорды + шум + периодические широкополосные атаки. Верхняя граница
/// сложности кадра (бюджет, carry, эскейпы энергий).
fn stress_dense(name: &'static str) -> CorpusItem {
    let rate = 48_000u32;
    let total = total_samples(rate, 2.0);
    let mut rng = Rng(0x57E5_50FF);
    let mut out = vec![0f32; total * 2];
    let mut phases = [0f64; 24];
    for j in 0..total {
        let mut acc = [0f32; 2];
        for (k, ph) in phases.iter_mut().enumerate() {
            let f = 60.0 * 2f64.powf(k as f64 * 0.42); // до ~ниже Найквиста
            if f > f64::from(rate) * 0.46 {
                continue;
            }
            *ph += f / f64::from(rate);
            let s = ((2.0 * PI * *ph).sin() / (1.0 + k as f64 * 0.15)) as f32;
            acc[0] += s;
            acc[1] += if k % 2 == 0 { s } else { -s };
        }
        let burst = j % (rate as usize / 3) < 96;
        for (c, a) in acc.iter().enumerate() {
            let noise = 0.18 * rng.bipolar();
            let click = if burst { 0.5 * rng.bipolar() } else { 0.0 };
            out[2 * j + c] = 0.3 * a + noise + click;
        }
    }
    normalize_peak(&mut out, 0.95);
    CorpusItem {
        name,
        class: Class::Edge,
        sample_rate: rate,
        channels: 2,
        pcm: out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corpus_is_deterministic_and_sane() {
        let a = full_corpus();
        let b = full_corpus();
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert_eq!(x.name, y.name);
            assert_eq!(x.pcm, y.pcm, "{}: недетерминированная генерация", x.name);
            let peak = x.pcm.iter().fold(0f32, |m, &v| m.max(v.abs()));
            assert!(peak <= 0.95 + 1e-6, "{}: пик {peak}", x.name);
            assert!(x.pcm.iter().all(|v| v.is_finite()), "{}: NaN/Inf", x.name);
            assert_eq!(x.pcm.len() % x.channels as usize, 0);
            let secs = x.pcm.len() as f32 / x.channels as f32 / x.sample_rate as f32;
            assert!(secs >= 1.5, "{}: слишком короткий ({secs} с)", x.name);
            if x.name != "near_silence_48k" {
                assert!(peak > 0.05, "{}: подозрительно тихий ({peak})", x.name);
            }
        }
        // Имена уникальны.
        let mut names: Vec<_> = a.iter().map(|i| i.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), a.len());
    }
}
