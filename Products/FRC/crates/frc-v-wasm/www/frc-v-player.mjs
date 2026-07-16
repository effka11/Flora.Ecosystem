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

/** Энкодер FRV1 поверх frc-v-wasm (RGBA из canvas/камеры или планарный I420). */
export class FrcVEncoder {
  /**
   * @param {string} wasmUrl
   * @param {{width: number, height: number, qp?: number, keyint?: number,
   *          speed?: number, loopFilter?: boolean, ssimTune?: boolean}} cfg
   * Размеры кратны 8. speed 0..2 (2 — интерактивное кодирование).
   */
  static async load(wasmUrl, cfg) {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
    return new FrcVEncoder(instance, cfg);
  }

  constructor(instance, { width, height, qp = 32, keyint = 60, speed = 2, loopFilter = true, ssimTune = false }) {
    this.ex = instance.exports;
    this.width = width;
    this.height = height;
    const flags = (loopFilter ? 0 : 1) | (ssimTune ? 2 : 0);
    this.handle = this.ex.frc_v_encoder_new(width, height, qp, keyint, speed, flags);
    if (!this.handle) throw new Error("invalid FRC-V encoder config");
    /** Был ли последний закодированный кадр ключевым. */
    this.lastKeyframe = false;
  }

  /** Кодирует кадр RGBA8888 (например, ImageData.data). Возвращает Uint8Array-пакет. */
  encodeRGBA(rgba) {
    return this.#encode(rgba, this.width * this.height * 4, this.ex.frc_v_encode_rgba);
  }

  /** Кодирует планарный кадр I420 (Y‖Cb‖Cr, w·h·3/2 байта). */
  encodeI420(yuv) {
    return this.#encode(yuv, (this.width * this.height * 3) / 2, this.ex.frc_v_encode_i420);
  }

  #encode(src, expectedLen, encodeFn) {
    if (src.byteLength !== expectedLen) throw new Error(`frame must be ${expectedLen} bytes`);
    const ex = this.ex;
    const ptr = ex.frc_v_alloc(src.byteLength);
    new Uint8Array(ex.memory.buffer, ptr, src.byteLength).set(src);
    const n = encodeFn(this.handle, ptr, src.byteLength);
    ex.frc_v_free(ptr, src.byteLength);
    if (n < 0) throw new Error("FRC-V encode failed");

    const out = ex.frc_v_alloc(n);
    ex.frc_v_packet(this.handle, out, n);
    // Копия: буфер пакета обязан переживать frc_v_free.
    const packet = new Uint8Array(new Uint8Array(ex.memory.buffer, out, n));
    ex.frc_v_free(out, n);
    this.lastKeyframe = ex.frc_v_packet_keyframe(this.handle) === 1;
    return packet;
  }

  destroy() {
    this.ex.frc_v_encoder_free(this.handle);
    this.handle = 0;
  }
}

/**
 * Мультиплексор нативного контейнера .frv (зеркало demuxFrv).
 * @param {Uint8Array[]} packets пакеты кадров в порядке воспроизведения (pts = индекс)
 * @returns {Uint8Array} готовый файл .frv
 */
export function muxFrv(packets, { width, height, fpsNum = 30, fpsDen = 1 }) {
  const total = 32 + packets.reduce((s, p) => s + 12 + p.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x8f465256, false); // magic 8F 46 52 56
  out[4] = 1; // версия контейнера
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  view.setUint32(10, fpsNum, true);
  view.setUint32(14, fpsDen, true);
  view.setUint32(18, packets.length, true);
  let off = 32;
  packets.forEach((p, i) => {
    view.setUint32(off, p.byteLength, true);
    view.setUint32(off + 4, i, true); // pts u64 LE: младшие 32 бита
    view.setUint32(off + 8, 0, true);
    out.set(p, off + 12);
    off += 12 + p.byteLength;
  });
  return out;
}
