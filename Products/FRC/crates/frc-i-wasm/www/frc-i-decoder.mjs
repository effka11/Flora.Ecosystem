// Минимальный лоадер frc-i-wasm для браузера (ES-модуль, без зависимостей).
//
// Сборка wasm:
//   cargo build -p frc-i-wasm --target wasm32-unknown-unknown --release
//   → target/wasm32-unknown-unknown/release/frc_i_wasm.wasm
//
// Использование:
//   import { FrcIDecoder } from "./frc-i-decoder.mjs";
//   const dec = await FrcIDecoder.load("/frc_i_wasm.wasm");
//   const info = dec.info(friBytes);        // { version, width, height, ... }
//   const img = dec.decode(friBytes);       // ImageData | null
//   if (img) ctx.putImageData(img, 0, 0);

const FLAG_LOSSLESS = 1;
const FLAG_ALPHA = 2;
const FLAG_CHROMA420 = 4;
const FLAG_IDENTITY = 8;
const FLAG_PALETTE = 16;
const FLAG_DEBLOCK = 32;
const FLAG_METADATA = 64;

export class FrcIDecoder {
  static async load(wasmUrl) {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
    return new FrcIDecoder(instance);
  }

  constructor(instance) {
    this.ex = instance.exports;
    this.version = this.ex.frc_i_version();
  }

  /** Читает заголовок .fri без декодирования тела; null при ошибке. */
  info(bytes) {
    const ex = this.ex;
    const ptr = this.#copyIn(bytes);
    const outPtr = ex.frc_i_alloc(20);
    const ok = ex.frc_i_info(ptr, bytes.byteLength, outPtr);
    let result = null;
    if (ok === 0) {
      const wire = new Uint32Array(ex.memory.buffer, outPtr, 5);
      const flags = wire[3];
      result = {
        version: wire[0],
        width: wire[1],
        height: wire[2],
        lossless: (flags & FLAG_LOSSLESS) !== 0,
        hasAlpha: (flags & FLAG_ALPHA) !== 0,
        chroma420: (flags & FLAG_CHROMA420) !== 0,
        identity: (flags & FLAG_IDENTITY) !== 0,
        palette: (flags & FLAG_PALETTE) !== 0,
        deblock: (flags & FLAG_DEBLOCK) !== 0,
        metadata: (flags & FLAG_METADATA) !== 0,
        quality: wire[4] === 0 ? null : wire[4],
      };
    }
    ex.frc_i_free(outPtr, 20);
    ex.frc_i_free(ptr, bytes.byteLength);
    return result;
  }

  /** Декодирует .fri; возвращает ImageData или null при ошибке. */
  decode(bytes) {
    const info = this.info(bytes);
    if (!info) return null;
    const ex = this.ex;
    const bpp = info.hasAlpha ? 4 : 3;
    const cap = info.width * info.height * bpp;

    const ptr = this.#copyIn(bytes);
    const outPtr = ex.frc_i_alloc(cap);
    const n = ex.frc_i_decode(ptr, bytes.byteLength, outPtr, cap);
    let img = null;
    if (n === cap) {
      // Копия: буфер ImageData обязан переживать frc_i_free.
      const px = new Uint8Array(ex.memory.buffer, outPtr, cap);
      const rgba = new Uint8ClampedArray(info.width * info.height * 4);
      if (bpp === 4) {
        rgba.set(px);
      } else {
        for (let i = 0, o = 0; i < cap; i += 3, o += 4) {
          rgba[o] = px[i];
          rgba[o + 1] = px[i + 1];
          rgba[o + 2] = px[i + 2];
          rgba[o + 3] = 255;
        }
      }
      img = new ImageData(rgba, info.width, info.height);
    }
    ex.frc_i_free(outPtr, cap);
    ex.frc_i_free(ptr, bytes.byteLength);
    return img;
  }

  /** Копирует байты в линейную память wasm; вернуть через frc_i_free. */
  #copyIn(bytes) {
    const ptr = this.ex.frc_i_alloc(bytes.byteLength);
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.byteLength).set(new Uint8Array(bytes));
    return ptr;
  }
}
