export type ObjectFit = "fill" | "contain" | "cover" | "none" | "scale-down";

export type ObjectPosition = {
  x: number;
  y: number;
};

export type Size = {
  width: number;
  height: number;
};

export type DrawRect = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
};

const DEFAULT_POSITION: ObjectPosition = { x: 0.5, y: 0.5 };

export function destBackingSize(
  clientWidth: number,
  clientHeight: number,
  dpr: number,
  bitmapWidth: number,
  bitmapHeight: number,
): Size {
  if (!(bitmapWidth > 0) || !(bitmapHeight > 0)) {
    return { width: 1, height: 1 };
  }
  if (!(clientWidth > 0) || !(clientHeight > 0)) {
    return { width: bitmapWidth, height: bitmapHeight };
  }
  const safeDpr = dpr > 0 ? dpr : 1;
  let width = Math.max(1, Math.round(clientWidth * safeDpr));
  let height = Math.max(1, Math.round(clientHeight * safeDpr));
  const cap = Math.min(1, bitmapWidth / width, bitmapHeight / height);
  if (cap < 1) {
    width = Math.max(1, Math.round(width * cap));
    height = Math.max(1, Math.round(height * cap));
  }
  return { width, height };
}

export function parseObjectFit(value: string): ObjectFit {
  switch (value.trim().toLowerCase()) {
    case "contain":
    case "cover":
    case "none":
    case "scale-down":
    case "fill":
      return value.trim().toLowerCase() as ObjectFit;
    default:
      return "fill";
  }
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function keywordAxis(token: string, axis: "x" | "y"): number | null {
  if (token === "center") return 0.5;
  if (axis === "x") {
    if (token === "left") return 0;
    if (token === "right") return 1;
    return null;
  }
  if (token === "top") return 0;
  if (token === "bottom") return 1;
  return null;
}

function percentOrKeyword(token: string, axis: "x" | "y"): number | null {
  const keyword = keywordAxis(token, axis);
  if (keyword !== null) return keyword;
  if (token.endsWith("%")) {
    const n = Number.parseFloat(token);
    return Number.isFinite(n) ? clampUnit(n / 100) : null;
  }
  if (token === "0" || token === "0px") return 0;
  return null;
}

export function parseObjectPosition(value: string): ObjectPosition {
  const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ...DEFAULT_POSITION };

  if (tokens.length === 1) {
    const token = tokens[0];
    if (token === "left" || token === "right") {
      return { x: token === "left" ? 0 : 1, y: 0.5 };
    }
    if (token === "top" || token === "bottom") {
      return { x: 0.5, y: token === "top" ? 0 : 1 };
    }
    if (token === "center") return { ...DEFAULT_POSITION };
    const x = percentOrKeyword(token, "x");
    return { x: x ?? 0.5, y: 0.5 };
  }

  const first = tokens[0];
  const second = tokens[1];
  const firstIsY = first === "top" || first === "bottom";
  if (firstIsY) {
    return {
      x: percentOrKeyword(second, "x") ?? 0.5,
      y: percentOrKeyword(first, "y") ?? 0.5,
    };
  }
  return {
    x: percentOrKeyword(first, "x") ?? 0.5,
    y: percentOrKeyword(second, "y") ?? 0.5,
  };
}

function roundRect(
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
): DrawRect {
  let rsx = Math.max(0, Math.floor(sx));
  let rsy = Math.max(0, Math.floor(sy));
  let rsw = Math.max(1, Math.round(sw));
  let rsh = Math.max(1, Math.round(sh));
  if (rsx + rsw > srcW) rsw = Math.max(1, srcW - rsx);
  if (rsy + rsh > srcH) rsh = Math.max(1, srcH - rsy);

  let rdx = Math.round(dx);
  let rdy = Math.round(dy);
  let rdw = Math.max(1, Math.round(dw));
  let rdh = Math.max(1, Math.round(dh));
  if (rdw > destW) rdw = destW;
  if (rdh > destH) rdh = destH;

  return { sx: rsx, sy: rsy, sw: rsw, sh: rsh, dx: rdx, dy: rdy, dw: rdw, dh: rdh };
}

function containRect(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
  pos: ObjectPosition,
): DrawRect {
  const scale = Math.min(destW / srcW, destH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const dx = (destW - dw) * pos.x;
  const dy = (destH - dh) * pos.y;
  return roundRect(0, 0, srcW, srcH, dx, dy, dw, dh, srcW, srcH, destW, destH);
}

function coverRect(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
  pos: ObjectPosition,
): DrawRect {
  const scale = Math.max(destW / srcW, destH / srcH);
  const sw = destW / scale;
  const sh = destH / scale;
  const sx = (srcW - sw) * pos.x;
  const sy = (srcH - sh) * pos.y;
  return roundRect(sx, sy, sw, sh, 0, 0, destW, destH, srcW, srcH, destW, destH);
}

function noneRect(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
  pos: ObjectPosition,
): DrawRect {
  const dx = (destW - srcW) * pos.x;
  const dy = (destH - srcH) * pos.y;
  return roundRect(0, 0, srcW, srcH, dx, dy, srcW, srcH, srcW, srcH, destW, destH);
}

export function objectFitDrawRect(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
  fit: ObjectFit,
  pos: ObjectPosition = DEFAULT_POSITION,
): DrawRect {
  const position = { x: clampUnit(pos.x), y: clampUnit(pos.y) };
  if (!(srcW > 0) || !(srcH > 0) || !(destW > 0) || !(destH > 0)) {
    return { sx: 0, sy: 0, sw: 1, sh: 1, dx: 0, dy: 0, dw: 1, dh: 1 };
  }
  switch (fit) {
    case "contain":
      return containRect(srcW, srcH, destW, destH, position);
    case "cover":
      return coverRect(srcW, srcH, destW, destH, position);
    case "none":
      return noneRect(srcW, srcH, destW, destH, position);
    case "scale-down":
      if (srcW <= destW && srcH <= destH) {
        return noneRect(srcW, srcH, destW, destH, position);
      }
      return containRect(srcW, srcH, destW, destH, position);
    case "fill":
    default:
      return roundRect(0, 0, srcW, srcH, 0, 0, destW, destH, srcW, srcH, destW, destH);
  }
}

export function readFrcNaturalSize(element: HTMLElement): Size | null {
  const width = Number(element.dataset.frcNaturalWidth);
  const height = Number(element.dataset.frcNaturalHeight);
  if (width > 0 && height > 0) return { width, height };
  return null;
}

export function writeFrcNaturalSize(element: HTMLElement, width: number, height: number): void {
  element.dataset.frcNaturalWidth = String(width);
  element.dataset.frcNaturalHeight = String(height);
}
