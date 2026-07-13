# FAC — Flora Audio Codec (Rust workspace)

Эталонная реализация аудио-кодека FAC. **Нормативная спецификация:
[`docs/codecs/FAC.md`](../../docs/codecs/FAC.md)** — битстрим определяется ею, код обязан ей
соответствовать. Действующая политика прод-пайплайнов — `docs/codecs/CODECS-AUDIO.md` (FAC в неё
пока не введён).

## Crates

| Crate | Что | Зависимости |
| --- | --- | --- |
| `fac-core` | Кодек: DSP + битстрим + контейнер FACS | нет (чистый Rust, no unsafe → готов к wasm32/FFI) |
| `fac-cli` (bin `fac`) | Инструмент разработки: gen/encode/decode/roundtrip поверх WAV | `hound`, `clap` |

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
cargo run --release -p fac-cli -- gen --output testdata/mix.wav --seconds 5
cargo run --release -p fac-cli -- roundtrip --input testdata/mix.wav --bitrate 96 --output testdata/mix.fac.wav
cargo run --release -p fac-cli -- encode --input testdata/mix.wav --output testdata/mix.fac --bitrate 96
cargo run --release -p fac-cli -- decode --input testdata/mix.fac --output testdata/mix.dec.wav
```

`testdata/` в git не попадает (см. `.gitignore`) — тестовые сигналы генерируются командой `gen`,
свои файлы кладите туда же. Вход: WAV 44.1/48 кГц, 1–2 канала, i16/i24/f32.

## API (fac-core)

```rust
let cfg = Config { sample_rate: 48_000, channels: 2, bitrate_bps: 96_000 };
let mut enc = Encoder::new(cfg)?;          // hop = FRAME_N interleaved-сэмплов на вызов
let packet = enc.encode_frame(&pcm)?;      // + один нулевой hop в конце потока (flush)
let mut dec = Decoder::new(48_000, 2)?;
let pcm_out = dec.decode_frame(&packet)?;  // ошибка на битом пакете, паник нет
let plc = dec.decode_lost();               // PLC при потере пакета
```

Задержка кодек-цепочки — `FRAME_N` (960) сэмплов; файловые инструменты отбрасывают её по
`num_samples` из заголовка FACS.

## Статус и роадмап

v0 = классическое MDCT-ядро (рабочий сквозной кодек, метрики в тестах и `fac roundtrip`):
низкоперекрывающееся окно, транзиентный режим (8 коротких MDCT против pre-echo, флаг bit0
пакета), gain-shape с fine-энергиями, water-filling-аллокация, бинарный range coder с
адаптивными контекстами (`rangecoder`), noise-fill, PLC.
`Encoder::set_transient_detection(false)` отключает детектор для A/B-замеров.
Дорожная карта до нейропрофиля FAC-NC — в спецификации, раздел Roadmap. Битстрим не заморожен
до v1.
