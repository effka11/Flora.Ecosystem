# FRC-A — Flora Relativistic Codec — Audio (Rust workspace)

Эталонная реализация аудио-кодека FRC-A. **Нормативная спецификация:
[`docs/codecs/FRC-A.md`](../../docs/codecs/FRC-A.md)** — битстрим определяется ею, код обязан ей
соответствовать. Действующая политика прод-пайплайнов — `docs/codecs/CODECS-AUDIO.md` (FRC-A в неё
пока не введён).

## Crates

| Crate | Что | Зависимости |
| --- | --- | --- |
| `frc-a-core` | Кодек: DSP + битстрим + контейнер FRAS | нет (чистый Rust, no unsafe → готов к wasm32/FFI) |
| `frc-a-cli` (bin `frc-a`) | Инструмент разработки: gen/encode/decode/roundtrip поверх WAV | `hound`, `clap` |

## Сборка и проверки

Toolchain зафиксирован (`rust-toolchain.toml`, как в `Backend/`). На Windows без MSVC Build Tools:

```powershell
rustup toolchain install 1.97.0-x86_64-pc-windows-gnu
rustup override set 1.97.0-x86_64-pc-windows-gnu --path .
```

```sh
cargo test --workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

## Быстрый старт (CLI)

```powershell
cargo run --release -p frc-a-cli -- gen --output testdata/mix.wav --seconds 5
cargo run --release -p frc-a-cli -- roundtrip --input testdata/mix.wav --bitrate 96 --output testdata/mix.fras.wav
cargo run --release -p frc-a-cli -- encode --input testdata/mix.wav --output testdata/mix.fras --bitrate 96
cargo run --release -p frc-a-cli -- decode --input testdata/mix.fras --output testdata/mix.dec.wav
```

`testdata/` в git не попадает (см. `.gitignore`) — тестовые сигналы генерируются командой `gen`,
свои файлы кладите туда же. Вход: WAV 44.1/48 кГц, 1–2 канала, i16/i24/f32.

## API (frc-a-core)

```rust
let cfg = Config { sample_rate: 48_000, channels: 2, bitrate_bps: 96_000 };
let mut enc = Encoder::new(cfg)?;          // hop = FRAME_N interleaved-сэмплов на вызов
let packet = enc.encode_frame(&pcm)?;      // + один нулевой hop в конце потока (flush)
let mut dec = Decoder::new(48_000, 2)?;
let pcm_out = dec.decode_frame(&packet)?;  // ошибка на битом пакете, паник нет
let plc = dec.decode_lost();               // PLC при потере пакета
```

Задержка кодек-цепочки — `FRAME_N` (960) сэмплов; файловые инструменты отбрасывают её по
`num_samples` из заголовка FRAS.

## Статус и роадмап

v0 = классическое MDCT-ядро (рабочий сквозной кодек, метрики в тестах и `frc-a roundtrip`):
низкоперекрывающееся окно, транзиентный режим (8 коротких MDCT против pre-echo, флаг bit0
пакета), gain-shape с fine-энергиями, water-filling-аллокация, бинарный range coder с
адаптивными контекстами (`rangecoder`), noise-fill, anti-collapse схлопнувшихся коротких
блоков (флаг bit1, шум на уровне энергий прошлых кадров), VBR-lite (транзиентные кадры
получают +25% бюджета с возвратом долга), PLC.
`Encoder::set_transient_detection(false)` отключает детектор для A/B-замеров.
Дорожная карта до нейропрофиля FRC-A-NC — в спецификации, раздел Roadmap. Битстрим не заморожен
до v1.
