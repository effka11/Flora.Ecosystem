/**
 * Typed facade over the FGCE C ABI. One instance owns one kernel `Engine`.
 *
 * Frames and pixels are returned as views into the wasm linear memory: they stay
 * valid until the next `submit` on the same instance. Copy before that (for
 * example into `ImageData`) when the data must outlive the next call.
 */

import {
  decodeResponse,
  encodeArbitrary,
  encodeBegin,
  encodeBlit,
  encodeClipPop,
  encodeClipPush,
  encodeDefineReference,
  encodeDrop,
  encodeEdgePx,
  encodeEnd,
  encodeEntity,
  encodeFillPath,
  encodeFillRect,
  encodeGrid,
  encodeGroup,
  encodeInfo,
  encodeLattice,
  encodeLength,
  encodeMeasure,
  encodePlace,
  encodeReadPixels,
  encodeRemove,
  encodeShow,
  encodeSnapshot,
  encodeStrokePath,
  encodeUpload,
  encodeUseReference,
  FgceError,
  type AlphaMode,
  type ArbitraryOptions,
  type Blend,
  type BoxOptions,
  type Color,
  type Edge,
  type Edges,
  type EntityKind,
  type EntityOptions,
  type Fill,
  type Frame,
  type Grid,
  type Info,
  type Lattice,
  type Pixels,
  type Pin,
  type PixelFormat,
  type Radius,
  type Rect,
  type FgceResponse,
  type Sample,
  type Snapshot,
  type Stroke,
  type Verb,
} from "./protocol";

/** ABI version this client speaks; `tests/abi-vectors` pin the same number. */
export const FGCE_ABI_VERSION = 2;

const instances = new Map<string, Promise<WebAssembly.Instance>>();

/**
 * Instantiates the module once per source URL. The renderer and the host-layout
 * exports share the instance (and its linear memory), so the wasm is fetched and
 * compiled once per page.
 */
export async function loadFgceInstance(
  source: string | URL | Response,
): Promise<WebAssembly.Instance> {
  if (source instanceof Response) {
    return (await instantiate(source)).instance;
  }
  const key = String(source);
  const cached = instances.get(key);
  if (cached) return cached;
  const next = (async () => {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`FGCE WASM HTTP ${response.status}`);
    return (await instantiate(response)).instance;
  })().catch((error: unknown) => {
    instances.delete(key);
    throw error;
  });
  instances.set(key, next);
  return next;
}

async function instantiate(
  response: Response,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  try {
    return await WebAssembly.instantiateStreaming(response.clone(), {});
  } catch {
    return await WebAssembly.instantiate(await response.arrayBuffer(), {});
  }
}

type WasmExports = {
  memory: WebAssembly.Memory;
  fgce_abi_version(): number;
  fgce_engine_new(): number;
  fgce_engine_free(engine: number): void;
  fgce_alloc(length: number): number;
  fgce_free(pointer: number, length: number): void;
  fgce_submit(engine: number, request: number, length: number): number;
  fgce_response_ptr(engine: number): number;
  fgce_response_len(engine: number): number;
};

function requireKind<K extends FgceResponse["kind"]>(
  response: FgceResponse,
  kind: K,
): Extract<FgceResponse, { kind: K }> {
  if (response.kind !== kind) {
    throw new Error(`FGCE expected ${kind}, got ${response.kind}`);
  }
  return response as Extract<FgceResponse, { kind: K }>;
}

export class FgceEngine {
  private destroyed = false;

  private constructor(
    private readonly wasm: WasmExports,
    private readonly engine: number,
  ) {}

  static async load(source: string | URL | Response): Promise<FgceEngine> {
    const instance = await loadFgceInstance(source);
    const wasm = instance.exports as unknown as WasmExports;
    const abi = wasm.fgce_abi_version();
    if (abi !== FGCE_ABI_VERSION) {
      throw new Error(`Несовместимый FGCE WASM: abi=${abi}, ожидался ${FGCE_ABI_VERSION}`);
    }
    return new FgceEngine(wasm, wasm.fgce_engine_new());
  }

  /** Executes one request; the response view lives until the next call. */
  submit(request: Uint8Array): FgceResponse {
    if (this.destroyed) throw new Error("FGCE engine is destroyed");
    const pointer = request.length === 0 ? 0 : this.wasm.fgce_alloc(request.length);
    if (request.length > 0 && pointer === 0) throw new Error("FGCE alloc failed");
    try {
      if (request.length > 0) {
        new Uint8Array(this.wasm.memory.buffer, pointer, request.length).set(request);
      }
      if (this.wasm.fgce_submit(this.engine, pointer, request.length) !== 0) {
        throw new Error("FGCE submit rejected the buffer");
      }
      const length = this.wasm.fgce_response_len(this.engine);
      const responsePointer = this.wasm.fgce_response_ptr(this.engine);
      return decodeResponse(new Uint8Array(this.wasm.memory.buffer, responsePointer, length));
    } finally {
      if (pointer !== 0) this.wasm.fgce_free(pointer, request.length);
    }
  }

  private ok(request: Uint8Array): Exclude<FgceResponse, { kind: "error" }> {
    const response = this.submit(request);
    if (response.kind === "error") throw new FgceError(response.code, response.codeIndex);
    return response;
  }

  info(): Info {
    return requireKind(this.ok(encodeInfo()), "info").info;
  }

  grid(k: number): Grid {
    return requireKind(this.ok(encodeGrid(k)), "grid").grid;
  }

  length(n: number, k: number): number {
    return requireKind(this.ok(encodeLength(n, k)), "length").length;
  }

  lattice(spanX: number, spanY: number, step: number, pinX: number, pinY: number): Lattice {
    return requireKind(
      this.ok(encodeLattice(spanX, spanY, step, pinX, pinY)),
      "lattice",
    ).lattice;
  }

  edgePx(edge: Edge, k: number): number {
    return requireKind(this.ok(encodeEdgePx(edge, k)), "edgePx").value;
  }

  measure(verbs: Verb[], fill?: Fill, stroke?: Stroke): Rect {
    return requireKind(this.ok(encodeMeasure(verbs, fill, stroke)), "measure").rect;
  }

  begin(width: number, height: number): void {
    this.ok(encodeBegin(width, height));
  }

  end(): Frame {
    return requireKind(this.ok(encodeEnd()), "frame").frame;
  }

  readPixels(rect: Rect, alpha: AlphaMode = "premul"): Pixels {
    return requireKind(this.ok(encodeReadPixels(rect, alpha)), "pixels").pixels;
  }

  upload(
    id: number,
    width: number,
    height: number,
    stride: number,
    format: PixelFormat,
    alpha: AlphaMode,
    bytes: Uint8Array,
  ): void {
    this.ok(encodeUpload(id, width, height, stride, format, alpha, bytes));
  }

  drop(id: number): void {
    this.ok(encodeDrop(id));
  }

  fillRect(rect: Rect, color: Color, blend?: Blend): void {
    this.ok(encodeFillRect(rect, color, blend));
  }

  entity(id: number, kind: EntityKind, edges: Edges, options?: EntityOptions): void {
    this.ok(encodeEntity(id, kind, edges, options));
  }

  group(id: number, parent: number, children: number[], options?: BoxOptions): void {
    this.ok(encodeGroup(id, parent, children, options));
  }

  arbitrary(
    id: number,
    parent: number,
    edges: Edges,
    children: number[],
    options?: ArbitraryOptions,
  ): void {
    this.ok(encodeArbitrary(id, parent, edges, children, options));
  }

  show(id: number, rect: Rect): void {
    this.ok(encodeShow(id, rect));
  }

  place(id: number, rect: Rect): void {
    this.ok(encodePlace(id, rect));
  }

  remove(id: number): void {
    this.ok(encodeRemove(id));
  }

  snapshot(): Snapshot {
    return requireKind(this.ok(encodeSnapshot()), "snapshot").snapshot;
  }

  defineReference(
    id: number,
    canonW: number,
    canonH: number,
    k: number,
    d: number,
    pin: Pin,
    enterCols: number,
    enterRows: number,
  ): void {
    this.ok(encodeDefineReference(id, canonW, canonH, k, d, pin, enterCols, enterRows));
  }

  useReference(id: number): void {
    this.ok(encodeUseReference(id));
  }

  clipPush(rect: Rect): void {
    this.ok(encodeClipPush(rect));
  }

  clipPop(): void {
    this.ok(encodeClipPop());
  }

  blit(
    id: number,
    dest: Rect,
    src: Rect,
    sample: Sample,
    tint?: Color,
    blend?: Blend,
    radius?: Radius,
  ): void {
    this.ok(encodeBlit(id, dest, src, sample, tint, blend, radius));
  }

  fillPath(verbs: Verb[], rule: Fill["rule"], color: Color, blend?: Blend): void {
    this.ok(encodeFillPath(verbs, rule, color, blend));
  }

  strokePath(verbs: Verb[], stroke: Stroke, color: Color, blend?: Blend): void {
    this.ok(encodeStrokePath(verbs, stroke, color, blend));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.wasm.fgce_engine_free(this.engine);
  }
}
