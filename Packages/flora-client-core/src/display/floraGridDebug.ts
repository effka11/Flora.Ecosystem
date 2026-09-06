/**
 * Dev console for the live Flora grid. No-op outside debug.
 * Enable: NODE_ENV=development / __DEV__, or `?flora-grid-debug=1`,
 * or localStorage `flora-grid-debug=1`, or `globalThis.__FLORA_GRID_DEBUG__ = true`.
 */

import {
  FLORA_GRID_FINE_PX,
  FLORA_GRID_PRIMARY_PX,
  FLORA_GRID_TEMPLATES,
  FLORA_GRID_WEB_BASE_HEIGHT,
  FLORA_GRID_WEB_BASE_WIDTH,
  gridCanvasSize,
  pickGridTemplate,
  type GridCanvasSize,
  type GridFamily,
  type GridTemplate,
  type PlaceGridCanvas,
  type ResolvedWebGridFrame
} from "./floraGridTemplates.js";

declare const __DEV__: boolean | undefined;

export type FloraGridDebugReason = "boot" | "up" | "down" | "hold" | "mode" | "size" | "idle";

export type FloraGridDebugLine = {
  label: string;
  value: string;
};

export type FloraGridDebugView = {
  reason: FloraGridDebugReason;
  reasonLabel: string;
  signature: string;
  headline: string;
  lines: FloraGridDebugLine[];
};

export type FloraGridDebugInput = {
  family: GridFamily;
  width: number;
  height: number;
  previousId?: string | null;
  chosen: GridTemplate;
  fitted: GridTemplate;
  canvas: GridCanvasSize;
  place?: PlaceGridCanvas | null;
};

const REASON_LABEL: Record<Exclude<FloraGridDebugReason, "idle">, string> = {
  boot: "старт",
  up: "↑ вверх",
  down: "↓ вниз",
  hold: "гистерезис",
  mode: "кадр",
  size: "окно"
};

let lastSignature = "";

export function resetFloraGridDebugState(): void {
  lastSignature = "";
}

export function isFloraGridDebugEnabled(): boolean {
  const flag = (globalThis as { __FLORA_GRID_DEBUG__?: unknown }).__FLORA_GRID_DEBUG__;
  if (flag === true) return true;
  if (flag === false) return false;
  if (webForceFlag()) return true;
  // Bare `process.env.NODE_ENV` so Next/webpack can inline it. Optional chaining
  // (`process.env?.NODE_ENV`) is a different AST node and stays undefined in the browser.
  if (process.env.NODE_ENV === "development") return true;
  if (typeof __DEV__ !== "undefined" && __DEV__) return true;
  return false;
}

function webForceFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage?.getItem("flora-grid-debug") === "1") return true;
    return new URLSearchParams(window.location.search).get("flora-grid-debug") === "1";
  } catch {
    return false;
  }
}

function fmt(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function fmtS(s: number): string {
  return Number.isInteger(s) ? String(s) : String(s);
}

function dim(w: number, h: number): string {
  return `${fmt(w)} × ${fmt(h)}`;
}

function cropMode(place: PlaceGridCanvas | null | undefined): "full" | "flush" | "letterbox" | "crop" {
  if (!place) return "full";
  if (place.cropX > 0 || place.cropY > 0) return "crop";
  if (place.frameLeft > 0.5 || place.frameTop > 0.5) return "letterbox";
  return "flush";
}

function findById(family: GridFamily, id: string | null | undefined): GridTemplate | undefined {
  if (!id) return undefined;
  return FLORA_GRID_TEMPLATES[family].find((t) => t.id === id);
}

function nextTemplate(current: GridTemplate): GridTemplate | undefined {
  const list = FLORA_GRID_TEMPLATES[current.family];
  const i = list.findIndex((t) => t.id === current.id);
  return i >= 0 ? list[i + 1] : undefined;
}

function frameCaption(place: PlaceGridCanvas, mode: ReturnType<typeof cropMode>): string {
  const frame = `${dim(place.frameWidth, place.frameHeight)}  @ ${fmt(place.frameLeft)}, ${fmt(place.frameTop)}`;
  if (mode === "crop") {
    return `${frame}  crop ${fmt(place.cropX)} × ${fmt(place.cropY)}`;
  }
  if (mode === "letterbox") {
    const x = place.frameLeft > 0.5 ? `гориз. +${fmt(place.frameLeft)}` : "";
    const y = place.frameTop > 0.5 ? `верт. +${fmt(place.frameTop)}` : "";
    return `${frame}  letterbox ${[x, y].filter(Boolean).join(" · ")}`;
  }
  return `${frame}  впритык`;
}

function nextHint(chosen: GridTemplate, width: number, height: number): string {
  const next = nextTemplate(chosen);
  if (!next) return "максимум шкалы";
  if (chosen.family === "web") {
    const needW = FLORA_GRID_WEB_BASE_WIDTH * next.s;
    const needH = FLORA_GRID_WEB_BASE_HEIGHT * next.s;
    const dW = Math.max(0, Math.ceil(needW - width));
    const dH = Math.max(0, Math.ceil(needH - height));
    return `${next.id}  s=${fmtS(next.s)}  нужно ${dim(needW, needH)}  (ещё ${dim(dW, dH)})`;
  }
  const short = Math.min(width, height);
  const need = next.minShortSide ?? 0;
  return `${next.id}  s=${fmtS(next.s)}  короткая ≥ ${need}  (ещё ${Math.max(0, Math.ceil(need - short))} px)`;
}

function holdHint(chosen: GridTemplate, canvas: GridCanvasSize): string {
  const slack = canvas.step;
  if (chosen.family === "web") {
    return `держим пока окно > ${dim(canvas.width - slack, canvas.height - slack)}  (slack ${fmt(slack)} px)`;
  }
  const threshold = chosen.minShortSide ?? 0;
  return `держим пока min(W,H) > ${fmt(threshold - slack)}  (порог ${fmt(threshold)} − slack ${fmt(slack)})`;
}

export function describeFloraGridDebug(input: FloraGridDebugInput): FloraGridDebugView {
  const { family, width, height, previousId, chosen, fitted, canvas, place } = input;
  const previous = findById(family, previousId ?? undefined);
  const mode = cropMode(place);
  const held = Boolean(previous && chosen.id === previous.id && fitted.id !== chosen.id);

  let reason: FloraGridDebugReason;
  if (!previous) {
    reason = "boot";
  } else if (chosen.s > previous.s) {
    reason = "up";
  } else if (chosen.s < previous.s) {
    reason = "down";
  } else if (held) {
    reason = "hold";
  } else {
    reason = "idle";
  }

  const signature =
    family === "mobile"
      ? `${family}|${chosen.id}|${fitted.id}|${held ? 1 : 0}|${Math.round(width)}x${Math.round(height)}`
      : `${family}|${chosen.id}|${fitted.id}|${held ? 1 : 0}|${mode}`;

  const stepNow = `${fmt(canvas.step)} / ${fmt(canvas.stepFine)}`;
  const prevStep = previous
    ? `${fmt(FLORA_GRID_PRIMARY_PX * previous.s)} / ${fmt(FLORA_GRID_FINE_PX * previous.s)}`
    : stepNow;
  const headline =
    reason === "up" || reason === "down"
      ? `${previous!.id} → ${chosen.id}   s=${fmtS(previous!.s)} → ${fmtS(chosen.s)}   шаг ${prevStep} → ${stepNow}`
      : `${chosen.id}   s=${fmtS(chosen.s)}   шаг ${stepNow}`;

  const lines: FloraGridDebugLine[] = [];

  if (reason === "up" || reason === "down") {
    lines.push({
      label: "шаблон",
      value: `${previous!.id}  →  ${chosen.id}`
    });
    lines.push({
      label: "шаг",
      value: `${prevStep}  →  ${stepNow}`
    });
  } else {
    lines.push({ label: "шаблон", value: `${chosen.id}  ·  s=${fmtS(chosen.s)}` });
    lines.push({ label: "шаг", value: `${stepNow} px  (primary / fine)` });
  }

  if (family === "mobile") {
    const short = Math.min(width, height);
    lines.push({
      label: "окно",
      value: `${dim(width, height)}  ·  короткая ${fmt(short)}`
    });
  } else {
    lines.push({ label: "окно", value: dim(width, height) });
    lines.push({
      label: "холст",
      value: `${dim(canvas.width, canvas.height)}  (${canvas.cols} × ${canvas.rows})`
    });
    if (place) {
      lines.push({ label: "кадр", value: frameCaption(place, mode) });
    }
  }

  if (held) {
    lines.push({ label: "влез бы", value: `${fitted.id}  s=${fmtS(fitted.s)}` });
    lines.push({ label: "порог", value: holdHint(chosen, canvas) });
  }

  lines.push({ label: "дальше", value: nextHint(chosen, width, height) });

  return {
    reason,
    reasonLabel: reason === "idle" ? "" : REASON_LABEL[reason],
    signature,
    headline,
    lines
  };
}

function supportsConsoleCss(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

const CSS = {
  badge:
    "background:#2c3527;color:#a4d18a;font:700 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:3px 8px;border-radius:4px 0 0 4px;letter-spacing:0.12em",
  boot: "background:#a4d18a;color:#0c0c0c;font:700 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:3px 8px",
  up: "background:#3d6b4f;color:#d4efc4;font:700 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:3px 8px",
  down: "background:#6b3d3d;color:#f0cfcf;font:700 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:3px 8px",
  hold: "background:#5c4a24;color:#f0e0b0;font:700 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:3px 8px",
  mode: "background:#2a3325;color:#a4d18a;font:700 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:3px 8px",
  size: "background:#2a3325;color:#a4d18a;font:700 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:3px 8px",
  rest: "background:#141414;color:#fafafa;font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:3px 10px;border-radius:0 4px 4px 0"
};

function reasonStyle(reason: Exclude<FloraGridDebugReason, "idle">): string {
  return CSS[reason];
}

function printView(view: FloraGridDebugView): void {
  if (view.reason === "idle") return;
  const reason = view.reason;
  const warn = console.warn as (message?: string, ...optionalParams: unknown[]) => void;
  warn(`[flora-grid] ${view.reasonLabel}  ${view.headline}`);
  if (supportsConsoleCss()) {
    warn(`%cflora-grid%c ${view.reasonLabel} %c ${view.headline}`, CSS.badge, reasonStyle(reason), CSS.rest);
  }
  for (const line of view.lines) {
    warn(`[flora-grid]   ${line.label.padEnd(10)} ${line.value}`);
  }
}

function buildInput(partial: Omit<FloraGridDebugInput, "fitted"> & { fitted?: GridTemplate }): FloraGridDebugInput {
  const fitted =
    partial.fitted ??
    pickGridTemplate({
      family: partial.family,
      width: partial.width,
      height: partial.height
    });
  return { ...partial, fitted };
}

/** Returns the view to print, or null if this pick is a duplicate / idle. */
export function takeFloraGridDebugView(
  partial: Omit<FloraGridDebugInput, "fitted"> & { fitted?: GridTemplate }
): FloraGridDebugView | null {
  let view = describeFloraGridDebug(buildInput(partial));
  if (view.signature === lastSignature) return null;
  if (view.reason === "idle") {
    if (!lastSignature) return null;
    view =
      partial.family === "mobile"
        ? { ...view, reason: "size", reasonLabel: REASON_LABEL.size }
        : { ...view, reason: "mode", reasonLabel: REASON_LABEL.mode };
  }
  lastSignature = view.signature;
  return view;
}

/** Classify a pick without printing. Idle = same template/mode, not worth a log line. */
export function reportFloraGridDebug(
  partial: Omit<FloraGridDebugInput, "fitted"> & { fitted?: GridTemplate }
): FloraGridDebugView | null {
  if (!isFloraGridDebugEnabled()) return null;
  const view = takeFloraGridDebugView(partial);
  if (view) printView(view);
  return view;
}

export function reportResolvedWebGridFrame(
  width: number,
  height: number,
  previousId: string | null | undefined,
  resolved: ResolvedWebGridFrame
): void {
  reportFloraGridDebug({
    family: "web",
    width,
    height,
    previousId,
    chosen: resolved.template,
    canvas: resolved.canvas,
    place: resolved.place
  });
}

export function reportMobileGridPick(options: {
  width: number;
  height: number;
  previousId?: string | null;
  chosen: GridTemplate;
}): void {
  reportFloraGridDebug({
    family: "mobile",
    width: options.width,
    height: options.height,
    previousId: options.previousId,
    chosen: options.chosen,
    canvas: gridCanvasSize(options.chosen)
  });
}
