# flora-video — FVC (Flora Video Codec)

Референсная реализация битстрима **FVC1 v0.1** (intra-only ядро).
Нормативная спецификация: [`docs/codecs/FVC.md`](../../docs/codecs/FVC.md);
семейство FMC и реестр сигнатур: [`docs/codecs/CODECS.md`](../../docs/codecs/CODECS.md).

## Состав

- `crates/fvc` — ядро: энкодер + декодер, без внешних зависимостей,
  `unsafe` запрещён, собирается под `wasm32-unknown-unknown`.
- `crates/fvc-cli` — бинарь `fvc`: encode / decode / info / psnr.
- `tools/gen_tables.mjs` — генератор нормативных таблиц (`tables.rs`).
- `tools/bench.ps1`, `tools/bdrate.mjs` — RD-кривые против x264 и BD-Rate.

## Использование

```powershell
cargo build --release
.\target\release\fvc.exe encode -i in.y4m -o out.fvc --qp 32   # y4m 4:2:0 8-бит
.\target\release\fvc.exe decode -i out.fvc -o dec.y4m
.\target\release\fvc.exe info   -i out.fvc
.\target\release\fvc.exe psnr   --ref in.y4m --dist dec.y4m
```

`--qp 0..63` — шаг квантования удваивается каждые +8; `--no-filter` отключает
деблокинг; `--frames N` ограничивает число кадров.

## Результаты (v0.1, intra, 30 кадров, PSNR overall)

BD-Rate против x264 `-preset medium -tune psnr -g 1` (отрицательное = FVC плотнее):

| Клип | BD-Rate |
| --- | --- |
| foreman_cif (352×288, натуральный) | **−0.1%** |
| testsrc2 (640×360, синтетика)      | **−6.4%** |

Воспроизведение: `pwsh tools/bench.ps1 -InputY4m bench/clip.y4m`,
затем `node tools/bdrate.mjs bench/clip.csv fvc x264`.

## Гарантии

- Декодер **бит-точно** воспроизводит реконструкцию энкодера (тест на каждом прогоне).
- Декодер **не паникует** на произвольном входе (однобайтовые/многобайтовые
  мутации, обрезки, мусор — в тестах).
- Нормативные пути — только целочисленная математика: детерминизм на всех
  платформах, включая wasm32.

## Проверки перед коммитом

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check -p fvc --target wasm32-unknown-unknown
```

## Границы v0.1 и план

Только intra (все кадры ключевые), YUV 4:2:0 8-бит, размеры кратны 8.
Дорожная карта (inter, rate control, SIMD, заморозка v1 golden-векторами) —
[`docs/codecs/FVC.md`](../../docs/codecs/FVC.md) §14.
