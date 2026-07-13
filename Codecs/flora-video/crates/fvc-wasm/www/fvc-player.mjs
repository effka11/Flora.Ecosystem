// Минимальный лоадер fvc-wasm для браузера (ES-модуль, без зависимостей).
//
// Сборка wasm:
//   cargo build -p fvc-wasm --target wasm32-unknown-unknown --release
//   → target/wasm32-unknown-unknown/release/fvc_wasm.wasm
//
// Использование:
//   import { FvcDecoder } from "./fvc-player.mjs";
//   const dec = await FvcDecoder.load("/fvc_wasm.wasm");
//   for (const packet of packets) {            // кадры из .fvc/.ivf демуксера
//     const img = dec.decode(packet);          // ImageData | null
//     if (img) ctx.putImageData(img, 0, 0);
//   }
//   dec.destroy();

export class FvcDecoder {
  static async load(wasmUrl) {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
    return new FvcDecoder(instance);
  }

  constructor(instance) {
    this.ex = instance.exports;
    this.handle = this.ex.fvc_decoder_new();
    this.version = this.ex.fvc_version();
  }

  /** Декодирует один пакет FVC1; возвращает ImageData или null при ошибке. */
  decode(packet) {
    const ex = this.ex;
    const ptr = ex.fvc_alloc(packet.byteLength);
    new Uint8Array(ex.memory.buffer, ptr, packet.byteLength).set(new Uint8Array(packet));
    const ok = ex.fvc_decode(this.handle, ptr, packet.byteLength);
    ex.fvc_free(ptr, packet.byteLength);
    if (ok !== 0) return null;

    const w = ex.fvc_frame_width(this.handle);
    const h = ex.fvc_frame_height(this.handle);
    const cap = w * h * 4;
    const rgbaPtr = ex.fvc_alloc(cap);
    const n = ex.fvc_frame_rgba(this.handle, rgbaPtr, cap);
    let img = null;
    if (n === cap) {
      // Копия: буфер ImageData обязан переживать fvc_free.
      const pixels = new Uint8ClampedArray(new Uint8Array(ex.memory.buffer, rgbaPtr, cap));
      img = new ImageData(pixels, w, h);
    }
    ex.fvc_free(rgbaPtr, cap);
    return img;
  }

  destroy() {
    this.ex.fvc_decoder_free(this.handle);
    this.handle = 0;
  }
}

/** Демуксер нативного контейнера .fvc (magic 8F 46 56 43): выдаёт пакеты кадров. */
export function* demuxFvc(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x8f465643) throw new Error("not an FVC file");
  let off = 32;
  while (off + 12 <= buffer.byteLength) {
    const size = view.getUint32(off, true);
    off += 12; // size u32 + pts u64
    if (off + size > buffer.byteLength) break;
    yield new Uint8Array(buffer, off, size);
    off += size;
  }
}
