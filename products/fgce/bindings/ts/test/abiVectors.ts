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
  strokeWidth,
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

const pixelRect = { x1: 0, y1: 0, x2: 7, y2: 7 };
const ink = { r: 1, g: 2, b: 3, a: 255 };
const centeredStroke = {
  widthQ8: strokeWidth(0.8),
  align: "center",
  join: { kind: "bevel" },
  cap: "butt",
  peak: "nominal",
} as const;

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
        name: "draw tree",
        op: "drawTree",
        args: {},
        requestHex: toHex(encodeDrawTree()),
      },
      {
        name: "empty entity",
        op: "entity",
        args: {
          id: 6,
          kind: { kind: "empty" } satisfies EntityKind,
          edges: {
            x1: { kind: "pixel", value: 0 },
            y1: { kind: "pixel", value: 0 },
            x2: { kind: "pixel", value: 3 },
            y2: { kind: "pixel", value: 3 },
          },
          options: { onGrid: false } satisfies EntityOptions,
        },
        requestHex: toHex(
          encodeEntity(
            6,
            { kind: "empty" },
            {
              x1: { kind: "pixel", value: 0 },
              y1: { kind: "pixel", value: 0 },
              x2: { kind: "pixel", value: 3 },
              y2: { kind: "pixel", value: 3 },
            },
            { onGrid: false },
          ),
        ),
      },
      {
        name: "fill rect with a 50% radius",
        op: "fillRect",
        args: {
          rect: pixelRect,
          color: ink,
          radius: { kind: "percent", value: 50 },
        },
        requestHex: toHex(
          encodeFillRect(pixelRect, ink, undefined, { kind: "percent", value: 50 }),
        ),
      },
      {
        name: "stroke round rect with center and nominal peak",
        op: "strokeRoundRect",
        args: {
          rect: pixelRect,
          radius: { kind: "percent", value: 50 },
          stroke: centeredStroke,
          color: ink,
        },
        requestHex: toHex(
          encodeStrokeRoundRect(pixelRect, { kind: "percent", value: 50 }, centeredStroke, ink),
        ),
      },
      {
        name: "fill lattice with a primary step",
        op: "fillLattice",
        args: {
          rect: pixelRect,
          step: 5,
          primaryStep: 15,
          fineColor: ink,
          primaryColor: ink,
        },
        requestHex: toHex(
          encodeFillLattice(pixelRect, 5, 15, ink, ink),
        ),
      },
      {
        name: "stroke path with center and nominal peak",
        op: "strokePath",
        args: {
          verbs: measureVerbs,
          stroke: centeredStroke,
          color: ink,
        },
        requestHex: toHex(encodeStrokePath(measureVerbs, centeredStroke, ink)),
      },
      {
        name: "stroke path with a fractional width",
        op: "strokePath",
        args: {
          verbs: measureVerbs,
          stroke: { ...centeredStroke, widthQ8: strokeWidth(0.7), peak: "light" },
          color: ink,
        },
        requestHex: toHex(
          encodeStrokePath(measureVerbs, { ...centeredStroke, widthQ8: strokeWidth(0.7), peak: "light" }, ink),
        ),
      },
      {
        name: "debug grid with a style",
        op: "debugGrid",
        args: {
          style: {
            base: { r: 171, g: 171, b: 171, a: 255 },
            tip: { r: 255, g: 0, b: 0, a: 128 },
            labelBase: { r: 242, g: 242, b: 242, a: 255 },
            labelTip: { r: 142, g: 142, b: 142, a: 255 },
            labelAlpha: 200,
            labelScale: 2,
          },
        },
        requestHex: toHex(
          encodeDebugGrid({
            base: { r: 171, g: 171, b: 171, a: 255 },
            tip: { r: 255, g: 0, b: 0, a: 128 },
            labelBase: { r: 242, g: 242, b: 242, a: 255 },
            labelTip: { r: 142, g: 142, b: 142, a: 255 },
            labelAlpha: 200,
            labelScale: 2,
          }),
        ),
      },
      {
        name: "debug grid with outline colors only",
        op: "debugGrid",
        args: {
          style: {
            base: { r: 171, g: 171, b: 171, a: 255 },
            tip: { r: 255, g: 0, b: 0, a: 128 },
            labelAlpha: 255,
            labelScale: 1,
          },
        },
        requestHex: toHex(
          encodeDebugGrid({
            base: { r: 171, g: 171, b: 171, a: 255 },
            tip: { r: 255, g: 0, b: 0, a: 128 },
            labelAlpha: 255,
            labelScale: 1,
          }),
        ),
      },
      {
        name: "debug hover point",
        op: "debugHover",
        args: { point: { x: 3, y: -4 } },
        requestHex: toHex(encodeDebugHover({ x: 3, y: -4 })),
      },
      {
        name: "debug label on the window",
        op: "debugLabel",
        args: { id: 0, text: "window" },
        requestHex: toHex(encodeDebugLabel(0, "window")),
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
