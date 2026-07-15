// Минимальный лоадер frc-v-wasm для браузера (ES-модуль, без зависимостей).
//
// Сборка wasm:
//   cargo build -p frc-v-wasm --target wasm32-unknown-unknown --release
//   → target/wasm32-unknown-unknown/release/frc_v_wasm.wasm
//
// Декодирование:
//   import { FrcVDecoder, demuxFrv } from "./frc-v-player.mjs";
//   const dec = await FrcVDecoder.load("/frc_v_wasm.wasm");
//   for (const packet of demuxFrv(buffer)) {   // кадры из .frv
//     const img = dec.decode(packet);          // ImageData | null
//     if (img) ctx.putImageData(img, 0, 0);
//   }
//   dec.destroy();
//
// Кодирование (например, кадры canvas):
//   import { FrcVEncoder, muxFrv } from "./frc-v-player.mjs";
//   const enc = await FrcVEncoder.load("/frc_v_wasm.wasm", { width, height, speed: 2 });
//   const packets = [];
//   for (const imageData of capturedFrames) packets.push(enc.encodeRGBA(imageData.data));
//   const frv = muxFrv(packets, { width, height, fpsNum: 30, fpsDen: 1 }); // Uint8Array
//   enc.destroy();

export class FrcVDecoder {
  static async load(wasmUrl) {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
    return new FrcVDecoder(instance);
  }

  constructor(instance) {
    this.ex = instance.exports;
    this.handle = this.ex.frc_v_decoder_new();
    this.version = this.ex.frc_v_version();
  }

  /** Декодирует один пакет FRV1; возвращает ImageData или null при ошибке. */
  decode(packet) {
    const ex = this.ex;
    const ptr = ex.frc_v_alloc(packet.byteLength);
    new Uint8Array(ex.memory.buffer, ptr, packet.byteLength).set(new Uint8Array(packet));
    const ok = ex.frc_v_decode(this.handle, ptr, packet.byteLength);
    ex.frc_v_free(ptr, packet.byteLength);
    if (ok !== 0) return null;

    const w = ex.frc_v_frame_width(this.handle);
    const h = ex.frc_v_frame_height(this.handle);
    const cap = w * h * 4;
    const rgbaPtr = ex.frc_v_alloc(cap);
    const n = ex.frc_v_frame_rgba(this.handle, rgbaPtr, cap);
    let img = null;
    if (n === cap) {
      // Копия: буфер ImageData обязан переживать frc_v_free.
      const pixels = new Uint8ClampedArray(new Uint8Array(ex.memory.buffer, rgbaPtr, cap));
      img = new ImageData(pixels, w, h);
    }
    ex.frc_v_free(rgbaPtr, cap);
    return img;
  }

  destroy() {
    this.ex.frc_v_decoder_free(this.handle);
    this.handle = 0;
  }
}

/** Демуксер нативного контейнера .frv (magic 8F 46 52 56): выдаёт пакеты кадров. */
export function* demuxFrv(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x8f465256) throw new Error("not an FRC-V file");
  let off = 32;
  while (off + 12 <= buffer.byteLength) {
    const size = view.getUint32(off, true);
    off += 12; // size u32 + pts u64
    if (off + size > buffer.byteLength) break;
    yield new Uint8Array(buffer, off, size);
    off += size;
  }
}
