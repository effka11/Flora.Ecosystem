/// <reference lib="webworker" />

import { FrcICodec } from "@flora/client-core/frc-i";

type CodecRequest =
  | { id: number; kind: "decode"; bytes: ArrayBuffer }
  | {
      id: number;
      kind: "encode";
      pixels: ArrayBuffer;
      width: number;
      height: number;
      quality: number;
    };

type CodecResponse =
  | { id: number; ok: true; rgba: ArrayBuffer; width: number; height: number }
  | { id: number; ok: true; fri: ArrayBuffer }
  | { id: number; ok: false; error: string };

let codecPromise: Promise<FrcICodec> | undefined;

function codec(): Promise<FrcICodec> {
  codecPromise ??= FrcICodec.load("/frc/frc_i_wasm.wasm");
  return codecPromise;
}

self.onmessage = async (event: MessageEvent<CodecRequest>) => {
  const { id } = event.data;
  try {
    if (event.data.kind === "encode") {
      const encoded = (await codec()).encode(
        new Uint8Array(event.data.pixels),
        event.data.width,
        event.data.height,
        4,
        event.data.quality,
      );
      const fri = encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength,
      ) as ArrayBuffer;
      const response: CodecResponse = { id, ok: true, fri };
      self.postMessage(response, { transfer: [fri] });
      return;
    }
    const { bytes } = event.data;
    const decoded = (await codec()).decode(new Uint8Array(bytes));
    const rgba = new Uint8ClampedArray(decoded.width * decoded.height * 4);
    if (decoded.bytesPerPixel === 4) {
      rgba.set(decoded.pixels);
    } else {
      for (let input = 0, output = 0; input < decoded.pixels.length; input += 3, output += 4) {
        rgba[output] = decoded.pixels[input] ?? 0;
        rgba[output + 1] = decoded.pixels[input + 1] ?? 0;
        rgba[output + 2] = decoded.pixels[input + 2] ?? 0;
        rgba[output + 3] = 255;
      }
    }
    const transfer = rgba.buffer.slice(
      rgba.byteOffset,
      rgba.byteOffset + rgba.byteLength,
    ) as ArrayBuffer;
    const response: CodecResponse = {
      id,
      ok: true,
      rgba: transfer,
      width: decoded.width,
      height: decoded.height,
    };
    self.postMessage(response, { transfer: [transfer] });
  } catch (error) {
    const response: CodecResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
