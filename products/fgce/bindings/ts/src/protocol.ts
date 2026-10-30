/**
 * Binary wire protocol of the FGCE host adapter (`docs/wasm-abi.md`, v3).
 *
 * Little-endian. Variable payloads (`verbs`, `children`, `Upload` bytes) are
 * appended to the request and addressed by offsets relative to its start.
 */

export type Rect = { x1: number; y1: number; x2: number; y2: number };
export type Color = { r: number; g: number; b: number; a: number };
export type Pin = { x: number; y: number };
export type Align = { x: number; y: number };

export type Edge =
  | { kind: "grid"; primary: number; fine?: number; spx?: number }
  | { kind: "pixel"; value: number };

export type Edges = { x1: Edge; y1: Edge; x2: Edge; y2: Edge };
export type Inset = { left?: Edge; top?: Edge; right?: Edge; bottom?: Edge };

/** Corner rounding: `edge` follows the length grammar, `percent` is of the smaller side. */
export type Radius =
  | { kind: "edge"; edge: Edge }
  | { kind: "percent"; value: number };

export type Verb =
  | { kind: "move"; x: number; y: number }
  | { kind: "line"; x: number; y: number }
  | { kind: "quad"; cx: number; cy: number; x: number; y: number }
  | { kind: "cubic"; c0x: number; c0y: number; c1x: number; c1y: number; x: number; y: number }
  | { kind: "close" };

export type Fill = { rule: "nonZero" | "evenOdd" };
export type Join = { kind: "miter"; limitQ8: number } | { kind: "bevel" } | { kind: "round" };
export type Cap = "butt" | "square" | "round";
export type StrokeAlign = "inside" | "outside" | "center";
export type Peak = "light" | "nominal";

/** One whole sPx in the 1/256 units of `Stroke.widthQ8` (`fgce.md` §8.4). */
export const STROKE_SPX_Q8 = 256;

/** Whole sPx to the `widthQ8` field: `strokeWidth(0.8) === 205`. */
export const strokeWidth = (pixels: number): number =>
  Math.round(pixels * STROKE_SPX_Q8);

export type Stroke = {
  /** Perpendicular width in 1/256 sPx; `0` is `BadStroke`. */
  widthQ8: number;
  align: StrokeAlign;
  join: Join;
  cap: Cap;
  peak?: Peak;
};

export type DebugGridStyle = {
  base: Color;
  tip: Color;
  /** Label scale start; omitted inherits `base`. */
  labelBase?: Color;
  /** Label scale end; omitted inherits `tip`. */
  labelTip?: Color;
  labelAlpha: number;
  labelScale: number;
};
export type DebugPoint = { x: number; y: number };

export type PixelFormat = "rgb8" | "rgba8" | "alpha8";
export type AlphaMode = "premul" | "straight";
export type Blend = "srcOver" | "src" | "clear" | "dstOut";
export type Sample = "crisp" | "area";

export type EntityKind =
  | { kind: "photo"; format: PixelFormat; image: number; tint?: Color }
  | { kind: "glyph"; format: PixelFormat; image: number; tint?: Color }
  | { kind: "vector"; verbs: Verb[]; fill?: Fill; stroke?: Stroke; color: Color }
  | { kind: "flat"; color: Color }
  | { kind: "box"; fill?: Fill; stroke?: Stroke; color: Color }
  | { kind: "empty" };

export type EntityOptions = { onGrid?: boolean; align?: Align; blend?: Blend; radius?: Radius };
export type BoxOptions = { pin?: Pin; snap?: boolean; inset?: Inset };
export type ArbitraryOptions = EntityOptions & BoxOptions;

export const FGCE_ERROR_NAMES = [
  "ScaleOutOfRange",
  "SurfaceOutOfRange",
  "NotBegun",
  "UnknownImage",
  "UnknownNode",
  "ImageTooLarge",
  "BufferLayout",
  "ClipUnderflow",
  "ClipOverflow",
  "BadCell",
  "Overflow",
  "BadStroke",
  "BadPath",
  "BadNudge",
  "BadAnchor",
  "BadGroup",
  "BadArbitrary",
  "BadInset",
  "BoxOverflow",
  "OffGrid",
  "BadParent",
  "ReferenceMissing",
  "ReferenceBusy",
  "BadRadius",
] as const;

export type FgceErrorName = (typeof FGCE_ERROR_NAMES)[number];

export class FgceError extends Error {
  constructor(
    readonly code: FgceErrorName,
    readonly codeIndex: number,
  ) {
    super(code);
    this.name = "FgceError";
  }
}

export type Info = {
  version: string;
  maxSide: number;
  maxK: number;
  maxClip: number;
  maxVertices: number;
  maxCoord: number;
  pixelFormat: PixelFormat;
  premultiplied: boolean;
};

export type Grid = { fine: number; primary: number };
export type Lattice = { countX: number; countY: number; originX: number; originY: number };
export type SnapshotNode = { id: number; parent: number; rect: Rect };
export type Snapshot = { generation: number; nodes: SnapshotNode[] };
export type Frame = { width: number; height: number; stride: number; pixels: Uint8Array };
export type Pixels = {
  x: number;
  y: number;
  width: number;
  height: number;
  stride: number;
  bytes: Uint8Array;
};

export type FgceResponse =
  | { kind: "none" }
  | { kind: "info"; info: Info }
  | { kind: "grid"; grid: Grid }
  | { kind: "length"; length: number }
  | { kind: "lattice"; lattice: Lattice }
  | { kind: "edgePx"; value: number }
  | { kind: "measure"; rect: Rect }
  | { kind: "frame"; frame: Frame }
  | { kind: "pixels"; pixels: Pixels }
  | { kind: "snapshot"; snapshot: Snapshot }
  | { kind: "error"; code: FgceErrorName; codeIndex: number };

export class Writer {
  private buffer: Uint8Array;
  private view: DataView;
  private position = 0;
  private deferred: { offsetPosition: number; bytes: Uint8Array }[] = [];

  constructor(capacity = 256) {
    this.buffer = new Uint8Array(Math.max(16, capacity));
    this.view = new DataView(this.buffer.buffer);
  }

  private ensure(length: number): void {
    const needed = this.position + length;
    if (needed <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.position));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    this.ensure(1);
    this.buffer[this.position++] = value & 0xff;
  }

  i8(value: number): void {
    this.u8(value & 0xff);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.position, value >>> 0, true);
    this.position += 4;
  }

  i32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.position, value | 0, true);
    this.position += 4;
  }

  /** Appends a blob and returns its absolute offset in the request. */
  bytes(value: Uint8Array): number {
    const offset = this.position;
    this.ensure(value.length);
    this.buffer.set(value, this.position);
    this.position += value.length;
    return offset;
  }

  /**
   * Reserves an `offset/len` pair and appends the blob at the end of the request.
   * The decoder reads the pair in place and follows the offset, so inline
   * payloads would land inside the fixed fields that follow.
   */
  deferredBlob(value: Uint8Array): void {
    this.deferred.push({ offsetPosition: this.position, bytes: value });
    this.u32(0);
    this.u32(0);
  }

  mark(): number {
    return this.position;
  }

  patchU32(position: number, value: number): void {
    this.view.setUint32(position, value >>> 0, true);
  }

  finish(): Uint8Array {
    for (const blob of this.deferred) {
      const offset = this.bytes(blob.bytes);
      this.patchU32(blob.offsetPosition, offset);
      this.patchU32(blob.offsetPosition + 4, blob.bytes.length);
    }
    this.deferred = [];
    return this.buffer.slice(0, this.position);
  }
}

export class Reader {
  private position = 0;

  constructor(private readonly data: Uint8Array) {}

  get isEmpty(): boolean {
    return this.position >= this.data.length;
  }

  private need(length: number): void {
    if (this.position + length > this.data.length) {
      throw new Error("FGCE response truncated");
    }
  }

  u8(): number {
    this.need(1);
    return this.data[this.position++];
  }

  i8(): number {
    return (this.u8() << 24) >> 24;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u32(): number {
    this.need(4);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.position, 4).getUint32(0, true);
    this.position += 4;
    return value;
  }

  i32(): number {
    this.need(4);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.position, 4).getInt32(0, true);
    this.position += 4;
    return value;
  }

  u64(): number {
    this.need(8);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.position, 8).getBigUint64(0, true);
    this.position += 8;
    return Number(value);
  }

  i64(): number {
    this.need(8);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.position, 8).getBigInt64(0, true);
    this.position += 8;
    return Number(value);
  }

  bytes(length: number): Uint8Array {
    this.need(length);
    const slice = this.data.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }
}

const FORMAT_CODE: Record<PixelFormat, number> = { rgb8: 0, rgba8: 1, alpha8: 2 };
const FORMAT_NAME: Record<number, PixelFormat> = { 0: "rgb8", 1: "rgba8", 2: "alpha8" };
const ALPHA_CODE: Record<AlphaMode, number> = { premul: 0, straight: 1 };
const BLEND_CODE: Record<Blend, number> = { srcOver: 0, src: 1, clear: 2, dstOut: 3 };
const RULE_CODE: Record<Fill["rule"], number> = { nonZero: 0, evenOdd: 1 };
const SAMPLE_CODE: Record<Sample, number> = { crisp: 0, area: 1 };
const STROKE_ALIGN_CODE: Record<StrokeAlign, number> = { inside: 0, outside: 1, center: 2 };
const PEAK_CODE: Record<Peak, number> = { light: 0, nominal: 1 };
const CAP_CODE: Record<Cap, number> = { butt: 0, square: 1, round: 2 };
const VERB_CODE = { move: 0, line: 1, quad: 2, cubic: 3, close: 4 } as const;
const ENTITY_CODE = { photo: 0, glyph: 1, vector: 2, flat: 3, box: 4, empty: 5 } as const;

export function writeRect(writer: Writer, rect: Rect): void {
  writer.i32(rect.x1);
  writer.i32(rect.y1);
  writer.i32(rect.x2);
  writer.i32(rect.y2);
}

export function writeColor(writer: Writer, color: Color): void {
  writer.u8(color.r);
  writer.u8(color.g);
  writer.u8(color.b);
  writer.u8(color.a);
}

function writeOptionalColor(writer: Writer, color: Color | undefined): void {
  writer.bool(color !== undefined);
  if (color) writeColor(writer, color);
}

function writeOptionalBlend(writer: Writer, blend: Blend | undefined): void {
  writer.bool(blend !== undefined);
  if (blend) writer.u8(BLEND_CODE[blend]);
}

function writeRadius(writer: Writer, radius: Radius): void {
  if (radius.kind === "edge") {
    writer.u8(0);
    writeEdge(writer, radius.edge);
  } else {
    writer.u8(1);
    writer.u8(radius.value);
  }
}

function writeOptionalRadius(writer: Writer, radius: Radius | undefined): void {
  writer.bool(radius !== undefined);
  if (radius) writeRadius(writer, radius);
}

function writeEdge(writer: Writer, edge: Edge): void {
  if (edge.kind === "grid") {
    writer.u8(0);
    writer.i32(edge.primary);
    writer.bool(edge.fine !== undefined);
    if (edge.fine !== undefined) writer.u8(edge.fine);
    writer.bool(edge.spx !== undefined);
    if (edge.spx !== undefined) writer.i32(edge.spx);
  } else {
    writer.u8(1);
    writer.i32(edge.value);
  }
}

export function writeEdges(writer: Writer, edges: Edges): void {
  writeEdge(writer, edges.x1);
  writeEdge(writer, edges.y1);
  writeEdge(writer, edges.x2);
  writeEdge(writer, edges.y2);
}

function writeOptionalInset(writer: Writer, inset: Inset | undefined): void {
  writer.bool(inset !== undefined);
  if (!inset) return;
  for (const side of [inset.left, inset.top, inset.right, inset.bottom]) {
    writer.bool(side !== undefined);
    if (side) writeEdge(writer, side);
  }
}

function writeFill(writer: Writer, fill: Fill): void {
  writer.u8(RULE_CODE[fill.rule]);
}

function writeOptionalFill(writer: Writer, fill: Fill | undefined): void {
  writer.bool(fill !== undefined);
  if (fill) writeFill(writer, fill);
}

function writeStroke(writer: Writer, stroke: Stroke): void {
  writer.u32(stroke.widthQ8);
  writer.u8(STROKE_ALIGN_CODE[stroke.align]);
  if (stroke.join.kind === "miter") {
    writer.u8(0);
    writer.u32(stroke.join.limitQ8);
  } else {
    writer.u8(stroke.join.kind === "bevel" ? 1 : 2);
  }
  writer.u8(CAP_CODE[stroke.cap]);
  writer.u8(PEAK_CODE[stroke.peak ?? "light"]);
}

function writeOptionalStroke(writer: Writer, stroke: Stroke | undefined): void {
  writer.bool(stroke !== undefined);
  if (stroke) writeStroke(writer, stroke);
}

function writeVerbsBlob(writer: Writer, verbs: Verb[]): void {
  const blob = new Writer(verbs.length * 12 + 8);
  for (const verb of verbs) {
    switch (verb.kind) {
      case "move":
        blob.u8(VERB_CODE.move);
        blob.i32(verb.x);
        blob.i32(verb.y);
        break;
      case "line":
        blob.u8(VERB_CODE.line);
        blob.i32(verb.x);
        blob.i32(verb.y);
        break;
      case "quad":
        blob.u8(VERB_CODE.quad);
        blob.i32(verb.cx);
        blob.i32(verb.cy);
        blob.i32(verb.x);
        blob.i32(verb.y);
        break;
      case "cubic":
        blob.u8(VERB_CODE.cubic);
        blob.i32(verb.c0x);
        blob.i32(verb.c0y);
        blob.i32(verb.c1x);
        blob.i32(verb.c1y);
        blob.i32(verb.x);
        blob.i32(verb.y);
        break;
      case "close":
        blob.u8(VERB_CODE.close);
        break;
    }
  }
  const bytes = blob.finish();
  writer.deferredBlob(bytes);
}

function writeChildrenBlob(writer: Writer, children: number[]): void {
  const blob = new Writer(children.length * 4);
  for (const id of children) blob.u32(id);
  const bytes = blob.finish();
  writer.deferredBlob(bytes);
}

function writeBytesBlob(writer: Writer, bytes: Uint8Array): void {
  writer.deferredBlob(bytes);
}

function writeKind(writer: Writer, kind: EntityKind): void {
  writer.u8(ENTITY_CODE[kind.kind]);
  switch (kind.kind) {
    case "photo":
    case "glyph":
      writer.u8(FORMAT_CODE[kind.format]);
      writer.u32(kind.image);
      writeOptionalColor(writer, kind.tint);
      break;
    case "vector":
      writeVerbsBlob(writer, kind.verbs);
      writeOptionalFill(writer, kind.fill);
      writeOptionalStroke(writer, kind.stroke);
      writeColor(writer, kind.color);
      break;
    case "flat":
      writeColor(writer, kind.color);
      break;
    case "box":
      writeOptionalFill(writer, kind.fill);
      writeOptionalStroke(writer, kind.stroke);
      writeColor(writer, kind.color);
      break;
    case "empty":
      break;
  }
}

export const OP = {
  info: 1,
  grid: 2,
  length: 3,
  lattice: 4,
  edgePx: 5,
  measure: 6,
  begin: 7,
  end: 8,
  readPixels: 9,
  upload: 10,
  drop: 11,
  fillRect: 12,
  entity: 13,
  group: 14,
  arbitrary: 15,
  show: 16,
  place: 17,
  remove: 18,
  snapshot: 19,
  defineReference: 20,
  useReference: 21,
  clipPush: 22,
  clipPop: 23,
  blit: 24,
  fillPath: 25,
  strokePath: 26,
  drawTree: 27,
  strokeRoundRect: 28,
  fillLattice: 29,
  debugGrid: 30,
  debugHover: 31,
  debugLabel: 32,
} as const;

export function encodeInfo(): Uint8Array {
  const writer = new Writer(1);
  writer.u8(OP.info);
  return writer.finish();
}

export function encodeGrid(k: number): Uint8Array {
  const writer = new Writer(5);
  writer.u8(OP.grid);
  writer.u32(k);
  return writer.finish();
}

export function encodeLength(n: number, k: number): Uint8Array {
  const writer = new Writer(9);
  writer.u8(OP.length);
  writer.u32(n);
  writer.u32(k);
  return writer.finish();
}

export function encodeLattice(spanX: number, spanY: number, step: number, pinX: number, pinY: number): Uint8Array {
  const writer = new Writer(15);
  writer.u8(OP.lattice);
  writer.u32(spanX);
  writer.u32(spanY);
  writer.u32(step);
  writer.i8(pinX);
  writer.i8(pinY);
  return writer.finish();
}

export function encodeEdgePx(edge: Edge, k: number): Uint8Array {
  const writer = new Writer(16);
  writer.u8(OP.edgePx);
  writeEdge(writer, edge);
  writer.u32(k);
  return writer.finish();
}

export function encodeMeasure(verbs: Verb[], fill?: Fill, stroke?: Stroke): Uint8Array {
  const writer = new Writer(32);
  writer.u8(OP.measure);
  writeVerbsBlob(writer, verbs);
  writeOptionalFill(writer, fill);
  writeOptionalStroke(writer, stroke);
  return writer.finish();
}

export function encodeBegin(width: number, height: number): Uint8Array {
  const writer = new Writer(9);
  writer.u8(OP.begin);
  writer.u32(width);
  writer.u32(height);
  return writer.finish();
}

export function encodeEnd(): Uint8Array {
  const writer = new Writer(1);
  writer.u8(OP.end);
  return writer.finish();
}

export function encodeDrawTree(): Uint8Array {
  const writer = new Writer(1);
  writer.u8(OP.drawTree);
  return writer.finish();
}

export function encodeReadPixels(rect: Rect, alpha: AlphaMode): Uint8Array {
  const writer = new Writer(22);
  writer.u8(OP.readPixels);
  writeRect(writer, rect);
  writer.u8(ALPHA_CODE[alpha]);
  return writer.finish();
}

export function encodeUpload(
  id: number,
  width: number,
  height: number,
  stride: number,
  format: PixelFormat,
  alpha: AlphaMode,
  bytes: Uint8Array,
): Uint8Array {
  const writer = new Writer(32 + bytes.length);
  writer.u8(OP.upload);
  writer.u32(id);
  writer.u32(width);
  writer.u32(height);
  writer.u32(stride);
  writer.u8(FORMAT_CODE[format]);
  writer.u8(ALPHA_CODE[alpha]);
  writeBytesBlob(writer, bytes);
  return writer.finish();
}

export function encodeDrop(id: number): Uint8Array {
  const writer = new Writer(5);
  writer.u8(OP.drop);
  writer.u32(id);
  return writer.finish();
}

export function encodeFillRect(
  rect: Rect,
  color: Color,
  blend?: Blend,
  radius?: Radius,
): Uint8Array {
  const writer = new Writer(40);
  writer.u8(OP.fillRect);
  writeRect(writer, rect);
  writeColor(writer, color);
  writeOptionalBlend(writer, blend);
  writeOptionalRadius(writer, radius);
  return writer.finish();
}

export function encodeStrokeRoundRect(
  rect: Rect,
  radius: Radius | undefined,
  stroke: Stroke,
  color: Color,
  blend?: Blend,
): Uint8Array {
  const writer = new Writer(48);
  writer.u8(OP.strokeRoundRect);
  writeRect(writer, rect);
  writeOptionalRadius(writer, radius);
  writeStroke(writer, stroke);
  writeColor(writer, color);
  writeOptionalBlend(writer, blend);
  return writer.finish();
}

export function encodeEntity(id: number, kind: EntityKind, edges: Edges, options: EntityOptions = {}): Uint8Array {
  const writer = new Writer(64);
  writer.u8(OP.entity);
  writer.u32(id);
  writeKind(writer, kind);
  writer.bool(options.onGrid !== undefined);
  if (options.onGrid !== undefined) writer.bool(options.onGrid);
  writeEdges(writer, edges);
  writer.bool(options.align !== undefined);
  if (options.align) {
    writer.i8(options.align.x);
    writer.i8(options.align.y);
  }
  writeOptionalBlend(writer, options.blend);
  writeOptionalRadius(writer, options.radius);
  return writer.finish();
}

export function encodeGroup(
  id: number,
  parent: number,
  children: number[],
  options: BoxOptions = {},
): Uint8Array {
  const writer = new Writer(32 + children.length * 4);
  writer.u8(OP.group);
  writer.u32(id);
  writer.u32(parent);
  writeChildrenBlob(writer, children);
  writer.i8(options.pin?.x ?? 0);
  writer.i8(options.pin?.y ?? 0);
  writer.bool(options.snap ?? false);
  writeOptionalInset(writer, options.inset);
  return writer.finish();
}

export function encodeArbitrary(
  id: number,
  parent: number,
  edges: Edges,
  children: number[],
  options: ArbitraryOptions = {},
): Uint8Array {
  const writer = new Writer(64 + children.length * 4);
  writer.u8(OP.arbitrary);
  writer.u32(id);
  writer.u32(parent);
  writer.bool(options.onGrid !== undefined);
  if (options.onGrid !== undefined) writer.bool(options.onGrid);
  writeEdges(writer, edges);
  writeChildrenBlob(writer, children);
  writer.i8(options.pin?.x ?? 0);
  writer.i8(options.pin?.y ?? 0);
  writer.bool(options.snap ?? false);
  writeOptionalInset(writer, options.inset);
  return writer.finish();
}

export function encodeShow(id: number, rect: Rect): Uint8Array {
  const writer = new Writer(21);
  writer.u8(OP.show);
  writer.u32(id);
  writeRect(writer, rect);
  return writer.finish();
}

export function encodePlace(id: number, rect: Rect): Uint8Array {
  const writer = new Writer(21);
  writer.u8(OP.place);
  writer.u32(id);
  writeRect(writer, rect);
  return writer.finish();
}

export function encodeRemove(id: number): Uint8Array {
  const writer = new Writer(5);
  writer.u8(OP.remove);
  writer.u32(id);
  return writer.finish();
}

export function encodeSnapshot(): Uint8Array {
  const writer = new Writer(1);
  writer.u8(OP.snapshot);
  return writer.finish();
}

export function encodeDefineReference(
  id: number,
  canonW: number,
  canonH: number,
  k: number,
  d: number,
  pin: Pin,
  enterCols: number,
  enterRows: number,
): Uint8Array {
  const writer = new Writer(32);
  writer.u8(OP.defineReference);
  writer.u32(id);
  writer.u32(canonW);
  writer.u32(canonH);
  writer.u32(k);
  writer.u32(d);
  writer.i8(pin.x);
  writer.i8(pin.y);
  writer.u32(enterCols);
  writer.u32(enterRows);
  return writer.finish();
}

export function encodeUseReference(id: number): Uint8Array {
  const writer = new Writer(5);
  writer.u8(OP.useReference);
  writer.u32(id);
  return writer.finish();
}

export function encodeClipPush(rect: Rect): Uint8Array {
  const writer = new Writer(17);
  writer.u8(OP.clipPush);
  writeRect(writer, rect);
  return writer.finish();
}

export function encodeClipPop(): Uint8Array {
  const writer = new Writer(1);
  writer.u8(OP.clipPop);
  return writer.finish();
}

export function encodeBlit(
  id: number,
  dest: Rect,
  src: Rect,
  sample: Sample,
  tint?: Color,
  blend?: Blend,
  radius?: Radius,
): Uint8Array {
  const writer = new Writer(48);
  writer.u8(OP.blit);
  writer.u32(id);
  writeRect(writer, dest);
  writeRect(writer, src);
  writer.u8(SAMPLE_CODE[sample]);
  writeOptionalColor(writer, tint);
  writeOptionalBlend(writer, blend);
  writeOptionalRadius(writer, radius);
  return writer.finish();
}

export function encodeFillPath(verbs: Verb[], rule: Fill["rule"], color: Color, blend?: Blend): Uint8Array {
  const writer = new Writer(32);
  writer.u8(OP.fillPath);
  writeVerbsBlob(writer, verbs);
  writer.u8(RULE_CODE[rule]);
  writeColor(writer, color);
  writeOptionalBlend(writer, blend);
  return writer.finish();
}

export function encodeFillLattice(
  rect: Rect,
  step: number,
  primaryStep: number | undefined,
  fineColor: Color,
  primaryColor: Color,
  blend?: Blend,
): Uint8Array {
  const writer = new Writer(44);
  writer.u8(OP.fillLattice);
  writeRect(writer, rect);
  writer.u32(step);
  writer.bool(primaryStep !== undefined);
  if (primaryStep !== undefined) writer.u32(primaryStep);
  writeColor(writer, fineColor);
  writeColor(writer, primaryColor);
  writeOptionalBlend(writer, blend);
  return writer.finish();
}

export function encodeStrokePath(
  verbs: Verb[],
  stroke: Stroke,
  color: Color,
  blend?: Blend,
): Uint8Array {
  const writer = new Writer(48);
  writer.u8(OP.strokePath);
  writeVerbsBlob(writer, verbs);
  writeStroke(writer, stroke);
  writeColor(writer, color);
  writeOptionalBlend(writer, blend);
  return writer.finish();
}

export function encodeDebugGrid(style?: DebugGridStyle): Uint8Array {
  const writer = new Writer(24);
  writer.u8(OP.debugGrid);
  writer.bool(style !== undefined);
  if (style) {
    writeColor(writer, style.base);
    writeColor(writer, style.tip);
    writeOptionalColor(writer, style.labelBase);
    writeOptionalColor(writer, style.labelTip);
    writer.u8(style.labelAlpha);
    writer.u8(style.labelScale);
  }
  return writer.finish();
}

export function encodeDebugHover(point?: DebugPoint): Uint8Array {
  const writer = new Writer(9);
  writer.u8(OP.debugHover);
  writer.bool(point !== undefined);
  if (point) {
    writer.i32(point.x);
    writer.i32(point.y);
  }
  return writer.finish();
}

export function encodeDebugLabel(id: number, text?: string): Uint8Array {
  const writer = new Writer(16);
  writer.u8(OP.debugLabel);
  writer.u32(id);
  writer.bool(text !== undefined);
  if (text !== undefined) writer.deferredBlob(new TextEncoder().encode(text));
  return writer.finish();
}

export function decodeResponse(data: Uint8Array): FgceResponse {
  const reader = new Reader(data);
  const kind = reader.u8();
  switch (kind) {
    case 0:
      return { kind: "none" };
    case 1: {
      const versionLength = reader.u32();
      const version = new TextDecoder().decode(reader.bytes(versionLength));
      return {
        kind: "info",
        info: {
          version,
          maxSide: reader.u32(),
          maxK: reader.u32(),
          maxClip: reader.u32(),
          maxVertices: reader.u32(),
          maxCoord: reader.u32(),
          pixelFormat: FORMAT_NAME[reader.u8()] ?? "rgba8",
          premultiplied: reader.bool(),
        },
      };
    }
    case 2:
      return { kind: "grid", grid: { fine: reader.u32(), primary: reader.u32() } };
    case 3:
      return { kind: "length", length: reader.u32() };
    case 4:
      return {
        kind: "lattice",
        lattice: {
          countX: reader.u32(),
          countY: reader.u32(),
          originX: reader.i64(),
          originY: reader.i64(),
        },
      };
    case 5:
      return { kind: "edgePx", value: reader.i32() };
    case 6:
      return {
        kind: "measure",
        rect: { x1: reader.i32(), y1: reader.i32(), x2: reader.i32(), y2: reader.i32() },
      };
    case 7: {
      const width = reader.u32();
      const height = reader.u32();
      const stride = reader.u32();
      const pixels = reader.bytes(reader.u32());
      return { kind: "frame", frame: { width, height, stride, pixels } };
    }
    case 8: {
      const x = reader.i32();
      const y = reader.i32();
      const width = reader.u32();
      const height = reader.u32();
      const stride = reader.u32();
      const bytes = reader.bytes(reader.u32());
      return { kind: "pixels", pixels: { x, y, width, height, stride, bytes } };
    }
    case 9: {
      const generation = reader.u64();
      const count = reader.u32();
      const nodes: SnapshotNode[] = [];
      for (let index = 0; index < count; index += 1) {
        nodes.push({
          id: reader.u32(),
          parent: reader.u32(),
          rect: { x1: reader.i32(), y1: reader.i32(), x2: reader.i32(), y2: reader.i32() },
        });
      }
      return { kind: "snapshot", snapshot: { generation, nodes } };
    }
    case 10: {
      const codeIndex = reader.u8();
      const code = FGCE_ERROR_NAMES[codeIndex];
      if (!code) throw new Error(`FGCE unknown error code ${codeIndex}`);
      return { kind: "error", code, codeIndex };
    }
    default:
      throw new Error(`FGCE unknown response kind ${kind}`);
  }
}
