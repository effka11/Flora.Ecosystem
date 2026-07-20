export const FRC_I_MIME = "image/x-flora-frc-i";
export const FRC_I_EXTENSION = "fri";
export const FRC_I_BITSTREAM_VERSION = 9;
export const FRC_I_WASM_ABI_VERSION = 2;

export type FrcIInfo = {
  version: number;
  width: number;
  height: number;
  lossless: boolean;
  hasAlpha: boolean;
  chroma420: boolean;
  identity: boolean;
  palette: boolean;
  deblock: boolean;
  metadata: boolean;
  quality: number | null;
};

export type FrcIDecodedPixels = FrcIInfo & {
  pixels: Uint8Array;
  bytesPerPixel: 3 | 4;
};

type FrcIWasmExports = {
  memory: WebAssembly.Memory;
  frc_i_version(): number;
  frc_i_alloc(length: number): number;
  frc_i_free(pointer: number, length: number): void;
  frc_i_info(data: number, length: number, output: number): number;
  frc_i_decode(data: number, length: number, output: number, capacity: number): number;
  frc_i_encode_capacity(width: number, height: number, bytesPerPixel: number): number;
  frc_i_encode(
    data: number,
    length: number,
    width: number,
    height: number,
    bytesPerPixel: number,
    quality: number,
    output: number,
    capacity: number,
  ): number;
};

const INFO_BYTES = 20;
const FLAG_LOSSLESS = 1;
const FLAG_ALPHA = 2;
const FLAG_CHROMA_420 = 4;
const FLAG_IDENTITY = 8;
const FLAG_PALETTE = 16;
const FLAG_DEBLOCK = 32;
const FLAG_METADATA = 64;

export class FrcIError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "capacity" | "encode" | "decode" | "abi",
  ) {
    super(message);
    this.name = "FrcIError";
  }
}

export class FrcICodec {
  static async load(source: string | URL | Response): Promise<FrcICodec> {
    const response = source instanceof Response ? source : await fetch(source);
    if (!response.ok) throw new FrcIError(`FRC-I WASM HTTP ${response.status}`, "abi");
    let result: WebAssembly.WebAssemblyInstantiatedSource;
    try {
      result = await WebAssembly.instantiateStreaming(response.clone(), {});
    } catch {
      result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    }
    return new FrcICodec(result.instance.exports as unknown as FrcIWasmExports);
  }

  readonly bitstreamVersion: number;
  readonly abiVersion: number;

  constructor(private readonly wasm: FrcIWasmExports) {
    const version = wasm.frc_i_version();
    this.bitstreamVersion = version >>> 8;
    this.abiVersion = version & 0xff;
    if (
      this.bitstreamVersion !== FRC_I_BITSTREAM_VERSION ||
      this.abiVersion !== FRC_I_WASM_ABI_VERSION
    ) {
      throw new FrcIError(
        `Несовместимый FRC-I WASM: bitstream=${this.bitstreamVersion}, abi=${this.abiVersion}`,
        "abi",
      );
    }
  }

  info(input: Uint8Array): FrcIInfo {
    const inputPointer = this.copyIn(input);
    const outputPointer = this.wasm.frc_i_alloc(INFO_BYTES);
    try {
      if (this.wasm.frc_i_info(inputPointer, input.byteLength, outputPointer) !== 0) {
        throw new FrcIError("Повреждённый FRC-I stream", "invalid");
      }
      const wire = new Uint32Array(this.wasm.memory.buffer, outputPointer, 5);
      const flags = wire[3] ?? 0;
      const quality = wire[4] ?? 0;
      return {
        version: wire[0] ?? 0,
        width: wire[1] ?? 0,
        height: wire[2] ?? 0,
        lossless: (flags & FLAG_LOSSLESS) !== 0,
        hasAlpha: (flags & FLAG_ALPHA) !== 0,
        chroma420: (flags & FLAG_CHROMA_420) !== 0,
        identity: (flags & FLAG_IDENTITY) !== 0,
        palette: (flags & FLAG_PALETTE) !== 0,
        deblock: (flags & FLAG_DEBLOCK) !== 0,
        metadata: (flags & FLAG_METADATA) !== 0,
        quality: quality === 0 ? null : quality,
      };
    } finally {
      this.wasm.frc_i_free(outputPointer, INFO_BYTES);
      this.wasm.frc_i_free(inputPointer, input.byteLength);
    }
  }

  decode(input: Uint8Array, maxPixels = 50_000_000): FrcIDecodedPixels {
    const info = this.info(input);
    const pixelCount = info.width * info.height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0 || pixelCount > maxPixels) {
      throw new FrcIError("FRC-I превышает клиентский лимит пикселей", "decode");
    }
    const bytesPerPixel = info.hasAlpha ? 4 : 3;
    const capacity = pixelCount * bytesPerPixel;
    const inputPointer = this.copyIn(input);
    const outputPointer = this.wasm.frc_i_alloc(capacity);
    try {
      const length = this.wasm.frc_i_decode(
        inputPointer,
        input.byteLength,
        outputPointer,
        capacity,
      );
      if (length !== capacity) throw new FrcIError("Не удалось декодировать FRC-I", "decode");
      return {
        ...info,
        bytesPerPixel,
        pixels: new Uint8Array(
          new Uint8Array(this.wasm.memory.buffer, outputPointer, capacity),
        ),
      };
    } finally {
      this.wasm.frc_i_free(outputPointer, capacity);
      this.wasm.frc_i_free(inputPointer, input.byteLength);
    }
  }

  encode(
    pixels: Uint8Array,
    width: number,
    height: number,
    bytesPerPixel: 3 | 4,
    quality = 75,
  ): Uint8Array {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      pixels.byteLength !== width * height * bytesPerPixel ||
      !Number.isInteger(quality) ||
      quality < 1 ||
      quality > 100
    ) {
      throw new FrcIError("Некорректные параметры FRC-I encode", "invalid");
    }
    const capacity = this.wasm.frc_i_encode_capacity(width, height, bytesPerPixel);
    const inputPointer = this.copyIn(pixels);
    const outputPointer = this.wasm.frc_i_alloc(capacity);
    try {
      const length = this.wasm.frc_i_encode(
        inputPointer,
        pixels.byteLength,
        width,
        height,
        bytesPerPixel,
        quality,
        outputPointer,
        capacity,
      );
      if (length === -2) throw new FrcIError("Малый output buffer FRC-I", "capacity");
      if (length === -3) throw new FrcIError("FRC-I encoder завершился ошибкой", "encode");
      if (length <= 0) throw new FrcIError("Некорректный FRC-I encode input", "invalid");
      return new Uint8Array(
        new Uint8Array(this.wasm.memory.buffer, outputPointer, length),
      );
    } finally {
      this.wasm.frc_i_free(outputPointer, capacity);
      this.wasm.frc_i_free(inputPointer, pixels.byteLength);
    }
  }

  private copyIn(input: Uint8Array): number {
    if (input.byteLength === 0) throw new FrcIError("Пустой FRC-I buffer", "invalid");
    const pointer = this.wasm.frc_i_alloc(input.byteLength);
    if (pointer === 0) throw new FrcIError("Не удалось выделить WASM memory", "capacity");
    new Uint8Array(this.wasm.memory.buffer, pointer, input.byteLength).set(input);
    return pointer;
  }
}

export function acceptsFrcI(contentType: string | null | undefined): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === FRC_I_MIME;
}
