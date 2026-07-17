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
  | { id: number; ok: true; png: ArrayBuffer }
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
    const canvas = new OffscreenCanvas(decoded.width, decoded.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("OffscreenCanvas 2D недоступен");
    context.putImageData(new ImageData(rgba, decoded.width, decoded.height), 0, 0);
    const png = await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
    const response: CodecResponse = { id, ok: true, png };
    self.postMessage(response, { transfer: [png] });
  } catch (error) {
    const response: CodecResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
