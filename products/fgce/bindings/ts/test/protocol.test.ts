import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  decodeResponse,
  encodeBegin,
  encodeDebugGrid,
  encodeDebugHover,
  encodeDebugLabel,
  encodeDrawTree,
  encodeEntity,
  encodeFillLattice,
  encodeFillRect,
  encodeInfo,
  encodeMeasure,
  encodeStrokePath,
  encodeStrokeRoundRect,
  encodeUpload,
  Reader,
  type AlphaMode,
  type Edges,
  type EntityKind,
  type EntityOptions,
  type PixelFormat,
  type Stroke,
  type Verb,
} from "../src/protocol";
import { FGCE_ABI_VERSION } from "../src/engine";
import { fromHex, toHex, type DecodingVector, type EncodingVector } from "./abiVectors";

const loadJson = async <T>(file: string): Promise<T> =>
  JSON.parse(
    await readFile(
      new URL(`../../../tests/abi-vectors/${file}`, import.meta.url),
      "utf8",
    ),
  ) as T;

function encodeVector(vector: EncodingVector): Uint8Array {
  switch (vector.op) {
    case "begin": {
      const args = vector.args as { width: number; height: number };
      return encodeBegin(args.width, args.height);
    }
    case "info":
      return encodeInfo();
    case "drawTree":
      return encodeDrawTree();
    case "upload": {
      const args = vector.args as {
        id: number;
        width: number;
        height: number;
        stride: number;
        format: PixelFormat;
        alpha: AlphaMode;
        bytesHex: string;
      };
      return encodeUpload(
        args.id,
        args.width,
        args.height,
        args.stride,
        args.format,
        args.alpha,
        fromHex(args.bytesHex),
      );
    }
    case "measure": {
      const args = vector.args as {
        verbs: Verb[];
        fill?: { rule: "nonZero" | "evenOdd" };
        stroke?: Stroke;
      };
      return encodeMeasure(args.verbs, args.fill, args.stroke);
    }
    case "entity": {
      const args = vector.args as {
        id: number;
        kind: EntityKind;
        edges: Edges;
        options?: EntityOptions;
      };
      return encodeEntity(args.id, args.kind, args.edges, args.options);
    }
    case "fillRect": {
      const args = vector.args as {
        rect: { x1: number; y1: number; x2: number; y2: number };
        color: { r: number; g: number; b: number; a: number };
        radius?: { kind: "percent"; value: number };
      };
      return encodeFillRect(args.rect, args.color, undefined, args.radius);
    }
    case "strokeRoundRect": {
      const args = vector.args as {
        rect: { x1: number; y1: number; x2: number; y2: number };
        radius?: { kind: "percent"; value: number };
        stroke: Stroke;
        color: { r: number; g: number; b: number; a: number };
      };
      return encodeStrokeRoundRect(args.rect, args.radius, args.stroke, args.color);
    }
    case "fillLattice": {
      const args = vector.args as {
        rect: { x1: number; y1: number; x2: number; y2: number };
        step: number;
        primaryStep?: number;
        fineColor: { r: number; g: number; b: number; a: number };
        primaryColor: { r: number; g: number; b: number; a: number };
      };
      return encodeFillLattice(
        args.rect,
        args.step,
        args.primaryStep,
        args.fineColor,
        args.primaryColor,
      );
    }
    case "strokePath": {
      const args = vector.args as {
        verbs: Verb[];
        stroke: Stroke;
        color: { r: number; g: number; b: number; a: number };
      };
      return encodeStrokePath(args.verbs, args.stroke, args.color);
    }
    case "debugGrid": {
      const args = vector.args as {
        style?: {
          base: { r: number; g: number; b: number; a: number };
          tip: { r: number; g: number; b: number; a: number };
          labelBase?: { r: number; g: number; b: number; a: number };
          labelTip?: { r: number; g: number; b: number; a: number };
          labelAlpha: number;
          labelScale: number;
        };
      };
      return encodeDebugGrid(args.style);
    }
    case "debugHover": {
      const args = vector.args as { point?: { x: number; y: number } };
      return encodeDebugHover(args.point);
    }
    case "debugLabel": {
      const args = vector.args as { id: number; text?: string };
      return encodeDebugLabel(args.id, args.text);
    }
    default:
      throw new Error(`unknown ABI vector op: ${vector.op}`);
  }
}

describe("ABI vectors", () => {
  it("pins the ABI version both ways", async () => {
    const encoding = await loadJson<{ abi: number }>("encoding.json");
    const decoding = await loadJson<{ abi: number }>("decoding.json");
    expect(encoding.abi).toBe(FGCE_ABI_VERSION);
    expect(decoding.abi).toBe(FGCE_ABI_VERSION);
  });

  it("encodes every request to the frozen bytes", async () => {
    const { vectors } = await loadJson<{ vectors: EncodingVector[] }>("encoding.json");
    for (const vector of vectors) {
      expect(toHex(encodeVector(vector)), vector.name).toBe(vector.requestHex);
    }
  });

  it("decodes every response to the expected value", async () => {
    const { vectors } = await loadJson<{ vectors: DecodingVector[] }>("decoding.json");
    for (const vector of vectors) {
      const response = decodeResponse(fromHex(vector.responseHex));
      const actual =
        response.kind === "frame"
          ? {
              kind: "frame" as const,
              width: response.frame.width,
              height: response.frame.height,
              stride: response.frame.stride,
              pixelsHex: toHex(response.frame.pixels),
            }
          : response;
      expect(actual, vector.name).toEqual(vector.expect);
    }
  });
});

describe("request encoding", () => {
  it("begin is the pinned golden bytes", () => {
    expect(Array.from(encodeBegin(4, 4))).toEqual([7, 4, 0, 0, 0, 4, 0, 0, 0]);
  });

  it("info is one opcode byte", () => {
    expect(Array.from(encodeInfo())).toEqual([1]);
  });

  it("upload appends the bytes and patches the offset", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const request = encodeUpload(9, 2, 2, 2, "alpha8", "premul", bytes);
    const reader = new Reader(request);
    expect(reader.u8()).toBe(10);
    expect(reader.u32()).toBe(9);
    expect(reader.u32()).toBe(2);
    expect(reader.u32()).toBe(2);
    expect(reader.u32()).toBe(2);
    expect(reader.u8()).toBe(2);
    expect(reader.u8()).toBe(0);
    const offset = reader.u32();
    expect(reader.u32()).toBe(4);
    expect(Array.from(request.subarray(offset, offset + 4))).toEqual([1, 2, 3, 4]);
  });

  it("measure encodes verbs as a blob and keeps fill optional", () => {
    const request = encodeMeasure(
      [
        { kind: "move", x: 1, y: 2 },
        { kind: "line", x: 3, y: 4 },
      ],
      { rule: "nonZero" },
    );
    const reader = new Reader(request);
    expect(reader.u8()).toBe(6);
    const offset = reader.u32();
    const length = reader.u32();
    expect(length).toBe(18);
    expect(reader.bool()).toBe(true);
    expect(reader.u8()).toBe(0);
    expect(reader.bool()).toBe(false);
    expect(Array.from(request.subarray(offset, offset + length))).toEqual([
      0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 3, 0, 0, 0, 4, 0, 0, 0,
    ]);
  });

  it("flat entity keeps the id, kind, on_grid, edges, align, blend, radius order", () => {
    const request = encodeEntity(
      5,
      { kind: "flat", color: { r: 1, g: 2, b: 3, a: 255 } },
      {
        x1: { kind: "pixel", value: 0 },
        y1: { kind: "pixel", value: 0 },
        x2: { kind: "pixel", value: 7 },
        y2: { kind: "pixel", value: 7 },
      },
      { onGrid: false },
    );
    const reader = new Reader(request);
    expect(reader.u8()).toBe(13);
    expect(reader.u32()).toBe(5);
    expect(reader.u8()).toBe(3);
    expect([reader.u8(), reader.u8(), reader.u8(), reader.u8()]).toEqual([1, 2, 3, 255]);
    expect(reader.bool()).toBe(true);
    expect(reader.bool()).toBe(false);
    for (const value of [0, 0, 7, 7]) {
      expect(reader.u8()).toBe(1);
      expect(reader.i32()).toBe(value);
    }
    expect(reader.bool()).toBe(false);
    expect(reader.bool()).toBe(false);
    expect(reader.bool()).toBe(false);
    expect(reader.isEmpty).toBe(true);
  });

  it("a rounded entity writes the radius after the blend", () => {
    const request = encodeEntity(
      5,
      { kind: "box", fill: { rule: "nonZero" }, color: { r: 1, g: 2, b: 3, a: 255 } },
      {
        x1: { kind: "pixel", value: 0 },
        y1: { kind: "pixel", value: 0 },
        x2: { kind: "pixel", value: 7 },
        y2: { kind: "pixel", value: 7 },
      },
      { onGrid: false, radius: { kind: "percent", value: 50 } },
    );
    const reader = new Reader(request);
    expect(reader.u8()).toBe(13);
    expect(reader.u32()).toBe(5);
    expect(reader.u8()).toBe(4);
    expect(reader.bool()).toBe(true);
    expect(reader.u8()).toBe(0);
    expect(reader.bool()).toBe(false);
    expect(reader.u8()).toBe(1);
    expect(reader.u8()).toBe(2);
    expect(reader.u8()).toBe(3);
    expect(reader.u8()).toBe(255);
    expect(reader.bool()).toBe(true);
    expect(reader.bool()).toBe(false);
    for (const value of [0, 0, 7, 7]) {
      expect(reader.u8()).toBe(1);
      expect(reader.i32()).toBe(value);
    }
    expect(reader.bool()).toBe(false);
    expect(reader.bool()).toBe(false);
    expect(reader.bool()).toBe(true);
    expect(reader.u8()).toBe(1);
    expect(reader.u8()).toBe(50);
    expect(reader.isEmpty).toBe(true);
  });
});

describe("response decoding", () => {
  it("decodes a frame with a stride", () => {
    const pixels = new Uint8Array(16);
    pixels.set([255, 0, 0, 255]);
    const payload = new Uint8Array(1 + 16 + 16);
    payload[0] = 7;
    const view = new DataView(payload.buffer);
    view.setUint32(1, 2, true);
    view.setUint32(5, 2, true);
    view.setUint32(9, 8, true);
    view.setUint32(13, 16, true);
    payload.set(pixels, 17);
    const response = decodeResponse(payload);
    expect(response.kind).toBe("frame");
    if (response.kind !== "frame") throw new Error("unreachable");
    expect(response.frame.width).toBe(2);
    expect(response.frame.stride).toBe(8);
    expect(Array.from(response.frame.pixels.subarray(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it("decodes an error name", () => {
    expect(decodeResponse(new Uint8Array([10, 6]))).toEqual({
      kind: "error",
      code: "BufferLayout",
      codeIndex: 6,
    });
  });

  it("decodes a snapshot", () => {
    const payload = new Uint8Array(1 + 8 + 4 + 24);
    payload[0] = 9;
    const view = new DataView(payload.buffer);
    view.setBigUint64(1, 3n, true);
    view.setUint32(9, 1, true);
    view.setUint32(13, 7, true);
    view.setUint32(17, 0, true);
    view.setInt32(21, 10, true);
    view.setInt32(25, 20, true);
    view.setInt32(29, 30, true);
    view.setInt32(33, 40, true);
    const response = decodeResponse(payload);
    expect(response.kind).toBe("snapshot");
    if (response.kind !== "snapshot") throw new Error("unreachable");
    expect(response.snapshot.generation).toBe(3);
    expect(response.snapshot.nodes).toEqual([
      { id: 7, parent: 0, rect: { x1: 10, y1: 20, x2: 30, y2: 40 } },
    ]);
  });
});
