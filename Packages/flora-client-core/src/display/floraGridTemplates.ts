/**
 * Flora UI grid templates — machine SoT.
 * Law: Documents/design/FLORA-GRID.md (do not duplicate the scale table there).
 */

export const FLORA_GRID_FINE_PX = 5;
export const FLORA_GRID_PRIMARY_PX = 15;
export const FLORA_GRID_WEB_COLS = 128;
export const FLORA_GRID_WEB_ROWS = 63;

/** Design canvas at s=1 (browser content measure on 1080p). */
export const FLORA_GRID_WEB_BASE_WIDTH = FLORA_GRID_WEB_COLS * FLORA_GRID_PRIMARY_PX;
export const FLORA_GRID_WEB_BASE_HEIGHT = FLORA_GRID_WEB_ROWS * FLORA_GRID_PRIMARY_PX;

export type GridFamily = "web" | "mobile";

export type GridTemplate = {
  id: string;
  family: GridFamily;
  /** Scale s = k/5 so both 5s and 15s are integer CSS px. */
  s: number;
  /** Mobile: min(W,H) must be >= this. Web templates omit (contain canvas instead). */
  minShortSide?: number;
};

export type GridCanvasSize = {
  width: number;
  height: number;
  step: number;
  stepFine: number;
  cols: number;
  rows: number;
};

export type PlaceGridCanvas = {
  left: number;
  top: number;
  cropX: number;
  cropY: number;
  frameWidth: number;
  frameHeight: number;
  frameLeft: number;
  frameTop: number;
};

const WEB_SCALES = [0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2] as const;

export const FLORA_WEB_GRID_TEMPLATES: readonly GridTemplate[] = WEB_SCALES.map((s) => ({
  id: `web-${String(s).replace(".", "-")}`,
  family: "web" as const,
  s
}));

export const FLORA_MOBILE_GRID_TEMPLATES: readonly GridTemplate[] = [
  { id: "mobile-1", family: "mobile", s: 1, minShortSide: 0 },
  { id: "mobile-1-2", family: "mobile", s: 1.2, minShortSide: 768 },
  { id: "mobile-1-4", family: "mobile", s: 1.4, minShortSide: 1024 }
];

export const FLORA_GRID_TEMPLATES = {
  web: FLORA_WEB_GRID_TEMPLATES,
  mobile: FLORA_MOBILE_GRID_TEMPLATES
} as const;

function assertScale(s: number): void {
  const fine = FLORA_GRID_FINE_PX * s;
  const primary = FLORA_GRID_PRIMARY_PX * s;
  if (!Number.isInteger(fine) || !Number.isInteger(primary)) {
    throw new Error(`Grid scale ${s} does not keep integer 5/15 CSS px`);
  }
}

export function gridCanvasSize(template: GridTemplate): GridCanvasSize {
  assertScale(template.s);
  const step = FLORA_GRID_PRIMARY_PX * template.s;
  const stepFine = FLORA_GRID_FINE_PX * template.s;
  if (template.family === "web") {
    return {
      width: FLORA_GRID_WEB_COLS * step,
      height: FLORA_GRID_WEB_ROWS * step,
      step,
      stepFine,
      cols: FLORA_GRID_WEB_COLS,
      rows: FLORA_GRID_WEB_ROWS
    };
  }
  return {
    width: 0,
    height: 0,
    step,
    stepFine,
    cols: 0,
    rows: 0
  };
}

function webFits(s: number, width: number, height: number): boolean {
  return FLORA_GRID_WEB_BASE_WIDTH * s <= width && FLORA_GRID_WEB_BASE_HEIGHT * s <= height;
}

function findTemplate(family: GridFamily, id: string | undefined): GridTemplate | undefined {
  if (!id) return undefined;
  return FLORA_GRID_TEMPLATES[family].find((t) => t.id === id);
}

function pickMaxWeb(width: number, height: number): GridTemplate {
  let chosen = FLORA_WEB_GRID_TEMPLATES[0]!;
  for (const t of FLORA_WEB_GRID_TEMPLATES) {
    if (webFits(t.s, width, height)) {
      chosen = t;
    }
  }
  return chosen;
}

function keepPreviousWeb(previous: GridTemplate, width: number, height: number): boolean {
  const canvas = gridCanvasSize(previous);
  const slack = canvas.step;
  return width > canvas.width - slack && height > canvas.height - slack;
}

function pickMaxMobile(width: number, height: number): GridTemplate {
  const short = Math.min(width, height);
  let chosen = FLORA_MOBILE_GRID_TEMPLATES[0]!;
  for (const t of FLORA_MOBILE_GRID_TEMPLATES) {
    if (short >= (t.minShortSide ?? 0)) {
      chosen = t;
    }
  }
  return chosen;
}

function keepPreviousMobile(previous: GridTemplate, width: number, height: number): boolean {
  const short = Math.min(width, height);
  const threshold = previous.minShortSide ?? 0;
  const slack = FLORA_GRID_PRIMARY_PX * previous.s;
  return short > threshold - slack;
}

export function pickGridTemplate(options: {
  family: GridFamily;
  width: number;
  height: number;
  previousId?: string | null;
}): GridTemplate {
  const { family, width, height, previousId } = options;
  const fitted =
    family === "web" ? pickMaxWeb(width, height) : pickMaxMobile(width, height);
  const previous = findTemplate(family, previousId ?? undefined);
  if (!previous || previous.s <= fitted.s) {
    return fitted;
  }
  const keep =
    family === "web"
      ? keepPreviousWeb(previous, width, height)
      : keepPreviousMobile(previous, width, height);
  return keep ? previous : fitted;
}

export function placeGridCanvas(options: {
  viewportW: number;
  viewportH: number;
  canvas: Pick<GridCanvasSize, "width" | "height">;
}): PlaceGridCanvas {
  const { viewportW, viewportH, canvas } = options;
  const frameWidth = Math.min(viewportW, canvas.width);
  const frameHeight = Math.min(viewportH, canvas.height);
  const frameLeft = (viewportW - frameWidth) / 2;
  const frameTop = (viewportH - frameHeight) / 2;
  const cropX = Math.max(0, (canvas.width - frameWidth) / 2);
  const cropY = Math.max(0, (canvas.height - frameHeight) / 2);
  return {
    frameWidth,
    frameHeight,
    frameLeft,
    frameTop,
    cropX,
    cropY,
    left: Math.round(frameLeft - cropX),
    top: Math.round(frameTop - cropY)
  };
}

export type ResolvedWebGridFrame = {
  template: GridTemplate;
  canvas: GridCanvasSize;
  place: PlaceGridCanvas;
};

export function resolveWebGridFrame(
  width: number,
  height: number,
  previousId?: string | null
): ResolvedWebGridFrame {
  const template = pickGridTemplate({ family: "web", width, height, previousId });
  const canvas = gridCanvasSize(template);
  const place = placeGridCanvas({ viewportW: width, viewportH: height, canvas });
  return { template, canvas, place };
}

/** Live CSS vars for the web family canvas. Host is typically <html>. */
export function applyWebGridFrameCssVars(host: {
  style: { setProperty: (name: string, value: string) => void };
}, resolved: ResolvedWebGridFrame): void {
  const { canvas, place } = resolved;
  host.style.setProperty("--flora-grid-step", `${canvas.step}px`);
  host.style.setProperty("--flora-grid-step-fine", `${canvas.stepFine}px`);
  host.style.setProperty("--flora-frame-width", `${place.frameWidth}px`);
  host.style.setProperty("--flora-frame-height", `${place.frameHeight}px`);
  host.style.setProperty("--flora-frame-left", `${place.frameLeft}px`);
  host.style.setProperty("--flora-frame-top", `${place.frameTop}px`);
  host.style.setProperty("--flora-crop-x", `${place.cropX}px`);
  host.style.setProperty("--flora-crop-y", `${place.cropY}px`);
  host.style.setProperty("--flora-app-root-w", `${canvas.width}px`);
  host.style.setProperty("--flora-app-root-h", `${canvas.height}px`);
}
