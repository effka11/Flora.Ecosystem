import type {
  AlphaMode,
  Edges,
  EntityKind,
  EntityOptions,
  PixelFormat,
  Verb,
} from "../src/protocol";
import {
  encodeBegin,
  encodeEntity,
  encodeInfo,
  encodeMeasure,
  encodeUpload,
} from "../src/protocol";
import { FGCE_ABI_VERSION } from "../src/engine";

export type EncodingVector = {
  name: string;
  op: string;
  args: Record<string, unknown>;
  requestHex: string;
};

export type DecodingVector = { name: string; responseHex: string; expect: unknown };

export type EncodingFile = {
  abi: number;
  description: string;
  vectors: EncodingVector[];
};

export type DecodingFile = {
  abi: number;
  description: string;
  vectors: DecodingVector[];
};

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const fromHex = (value: string): Uint8Array => {
  if (value.length % 2 !== 0) throw new Error(`odd hex length: ${value.length}`);
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const pixelEdges: Edges = {
  x1: { kind: "pixel", value: 0 },
  y1: { kind: "pixel", value: 0 },
  x2: { kind: "pixel", value: 7 },
  y2: { kind: "pixel", value: 7 },
};

const flatKind: EntityKind = {
  kind: "flat",
  color: { r: 1, g: 2, b: 3, a: 255 },
};

const boxKind: EntityKind = {
  kind: "box",
  fill: { rule: "nonZero" },
  color: { r: 1, g: 2, b: 3, a: 255 },
};

const measureVerbs: Verb[] = [
  { kind: "move", x: 1, y: 2 },
  { kind: "line", x: 3, y: 4 },
];

const measureFill = { rule: "nonZero" } as const;

const uploadBytes = new Uint8Array([1, 2, 3, 4]);

/** Frozen request bytes, built by the reference encoder only. */
export function buildEncodingFile(): EncodingFile {
  return {
    abi: FGCE_ABI_VERSION,
    description:
      "Frozen request bytes. Every FGCE binding must encode the same logical call to the same bytes.",
    vectors: [
      {
        name: "begin 4x4",
        op: "begin",
        args: { width: 4, height: 4 },
        requestHex: toHex(encodeBegin(4, 4)),
      },
      {
        name: "info",
        op: "info",
        args: {},
        requestHex: toHex(encodeInfo()),
      },
      {
        name: "upload alpha8 2x2",
        op: "upload",
        args: {
          id: 9,
          width: 2,
          height: 2,
          stride: 2,
          format: "alpha8" satisfies PixelFormat,
          alpha: "premul" satisfies AlphaMode,
          bytesHex: toHex(uploadBytes),
        },
        requestHex: toHex(
          encodeUpload(9, 2, 2, 2, "alpha8", "premul", uploadBytes),
        ),
      },
      {
        name: "measure move+line without stroke",
        op: "measure",
        args: {
          verbs: measureVerbs,
          fill: measureFill,
        },
        requestHex: toHex(encodeMeasure(measureVerbs, measureFill)),
      },
      {
        name: "flat entity after blend and radius fields",
        op: "entity",
        args: {
          id: 5,
          kind: flatKind,
          edges: pixelEdges,
          options: { onGrid: false } satisfies EntityOptions,
        },
        requestHex: toHex(
          encodeEntity(5, flatKind, pixelEdges, { onGrid: false }),
        ),
      },
      {
        name: "box entity with a 50% radius",
        op: "entity",
        args: {
          id: 5,
          kind: boxKind,
          edges: pixelEdges,
          options: {
            onGrid: false,
            radius: { kind: "percent", value: 50 },
          } satisfies EntityOptions,
        },
        requestHex: toHex(
          encodeEntity(5, boxKind, pixelEdges, {
            onGrid: false,
            radius: { kind: "percent", value: 50 },
          }),
        ),
      },
    ],
  };
}

function frameResponse(): Uint8Array {
  const payload = new Uint8Array(1 + 16 + 16);
  payload[0] = 7;
  const view = new DataView(payload.buffer);
  view.setUint32(1, 2, true);
  view.setUint32(5, 2, true);
  view.setUint32(9, 8, true);
  view.setUint32(13, 16, true);
  payload.set([255, 0, 0, 255], 17);
  return payload;
}

function snapshotResponse(): Uint8Array {
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
  return payload;
}

/** Frozen response bytes, built by the reference encoder only. */
export function buildDecodingFile(): DecodingFile {
  const frame = frameResponse();
  return {
    abi: FGCE_ABI_VERSION,
    description:
      "Frozen response bytes. Every FGCE binding must decode the same response to the same values.",
    vectors: [
      {
        name: "error BufferLayout",
        responseHex: "0a06",
        expect: { kind: "error", code: "BufferLayout", codeIndex: 6 },
      },
      {
        name: "frame 2x2 with stride",
        responseHex: toHex(frame),
        expect: {
          kind: "frame",
          width: 2,
          height: 2,
          stride: 8,
          pixelsHex: toHex(frame.subarray(17)),
        },
      },
      {
        name: "snapshot with one node",
        responseHex: toHex(snapshotResponse()),
        expect: {
          kind: "snapshot",
          snapshot: {
            generation: 3,
            nodes: [{ id: 7, parent: 0, rect: { x1: 10, y1: 20, x2: 30, y2: 40 } }],
          },
        },
      },
    ],
  };
}
