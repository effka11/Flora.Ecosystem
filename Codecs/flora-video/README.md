# flora-video — FRC-V (Flora Relativistic Codec — video)

Референсная реализация битстрима **FRV1 v2** (v1 Released: intra + inter, GOP,
контейнер `.frv`, WASM-декодер). Нормативная спецификация:
[`docs/codecs/FRC-V.md`](../../docs/codecs/FRC-V.md); семейство FRC:
[`docs/codecs/CODECS.md`](../../docs/codecs/CODECS.md).

## Состав

| Crate | Назначение |
| --- | --- |
| `crates/frc-v` | Ядро: энкодер + декодер, pure std, `unsafe` запрещён |
| `crates/frc-v-cli` | `frc-v`: encode / decode / info / psnr |
| `crates/frc-v-wasm` | WASM-декодер для Apps/Web (`www/frc-v-player.mjs`) |
| `tools/` | `gen_tables.mjs`, `bench.ps1`, `bdrate.mjs` |

## Использование

```powershell
cargo build --release
.\target\release\frc-v.exe encode -i in.y4m -o out.frv --qp 32 --keyint 60
.\target\release\frc-v.exe encode -i in.y4m -o out.frv --bitrate 500 --keyint 30 --ssim-tune
.\target\release\frc-v.exe decode -i out.frv -o dec.y4m
.\target\release\frc-v.exe info   -i out.frv
.\target\release\frc-v.exe psnr   --ref in.y4m --dist dec.y4m
```

Опции encode:

- `--qp 0..63` — фиксированное квантование (шаг ×2 каждые +8 qp)
- `--bitrate <kbps>` — однопроходный rate control (смещение qp)
- `--keyint <N>` — GOP: ключ каждые N кадров (1 = all-intra)
- `--ssim-tune` — психовизуальная настройка RDO (SSE + SSIM-прокси)
- `--no-filter` — без деблокинга; `--frames N` — лимит кадров

Контейнер: `.frv` (нативный, magic `8F 46 52 56`) или `.ivf` (FourCC `FRV1`).

### WASM

```powershell
rustup target add wasm32-unknown-unknown
cargo build -p frc-v-wasm --target wasm32-unknown-unknown --release
cargo check -p frc-v --target wasm32-unknown-unknown
```

## Результаты BD-Rate (30 кадров, PSNR overall, x264 `-preset medium -tune psnr`)

Отрицательное = FRC-V плотнее при том же PSNR.

| Режим | Клип | BD-Rate |
| --- | --- | --- |
| intra (`-g 1`) | foreman_cif | **−0.1%** |
| intra | testsrc2 640×360 | **−6.4%** |
| inter (`-g 30`) | foreman_cif | запустите `pwsh tools/bench.ps1 -InputY4m bench/foreman_cif.y4m -Keyint 30` |

Воспроизведение: `pwsh tools/bench.ps1 -InputY4m bench/clip.y4m [-Keyint N]`,
затем `node tools/bdrate.mjs bench/clip.csv frc-v x264`.

## Гарантии

- Декодер **бит-точно** воспроизводит реконструкцию энкодера.
- Декодер **не паникует** на произвольном входе (fuzz в `tests/codec.rs`).
- Битстрим v2 **заморожен** golden-векторами (`tests/golden.rs`, `tests/data/golden.sums`).
- Нормативные пути — целочисленная математика; wasm32-декодер детерминирован.

## Проверки

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check -p frc-v --target wasm32-unknown-unknown
```

Регенерация golden (только при осознанном изменении битстрима):

```powershell
$env:FRC_V_UPDATE_GOLDEN = "1"
cargo test -p frc-v --test golden
```

## Границы v1

Реализовано: YUV 4:2:0 8-бит, intra + P-кадры (одна ссылка), GOP, rate control,
SSIM-tune, `.frv` + IVF, WASM decode.

Не в v1: B-кадры, tile-параллелизм в битстриме, A/V-mux с FRC-A, продакшен-энкодер
в браузере. См. [`docs/codecs/FRC-V.md`](../../docs/codecs/FRC-V.md) §14.
