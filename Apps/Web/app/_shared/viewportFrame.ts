"use client";

import { useEffect } from "react";
import {
  FLORA_GRID_WEB_BASE_HEIGHT,
  FLORA_GRID_WEB_BASE_WIDTH,
  applyWebGridFrameCssVars,
  resolveWebGridFrame,
  takeFloraGridDebugView,
  type ResolvedWebGridFrame
} from "@flora/client-core/display";

export type ViewportFrame = {
  viewportWidth: number;
  viewportHeight: number;
  frameWidth: number;
  frameHeight: number;
  frameLeft: number;
  frameTop: number;
  frameRight: number;
  frameBottom: number;
  cropOffsetX: number;
  cropOffsetY: number;
  step: number;
  stepFine: number;
  templateId: string;
};

type ViewportSize = {
  width: number;
  height: number;
};

/** Hysteresis: last web template id for this document. */
let lastWebTemplateId: string | undefined;

function logFloraGrid(width: number, height: number, previousId: string | undefined, resolved: ResolvedWebGridFrame) {
  if (process.env.NODE_ENV === "production") return;
  const view = takeFloraGridDebugView({
    family: "web",
    width,
    height,
    previousId,
    chosen: resolved.template,
    canvas: resolved.canvas,
    place: resolved.place
  });
  if (!view) return;
  // console.warn: Cursor/Next forwards browser warnings to this terminal (`[browser]`), not console.log.
  console.warn(`[flora-grid] ${view.reasonLabel}  ${view.headline}`);
  for (const line of view.lines) {
    console.warn(`[flora-grid]   ${line.label.padEnd(10)} ${line.value}`);
  }
}

function getViewportSize(): ViewportSize {
  if (typeof window === "undefined") {
    // эталон s=1
    return { width: FLORA_GRID_WEB_BASE_WIDTH, height: FLORA_GRID_WEB_BASE_HEIGHT };
  }

  const vv = window.visualViewport;
  if (vv) {
    return {
      width: Math.round(vv.width),
      height: Math.round(vv.height)
    };
  }

  return {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight
  };
}

export function getViewportFrame(
  viewportWidth: number = getViewportSize().width,
  viewportHeight: number = getViewportSize().height
): ViewportFrame {
  const resolved = resolveWebGridFrame(viewportWidth, viewportHeight, lastWebTemplateId);
  logFloraGrid(viewportWidth, viewportHeight, lastWebTemplateId, resolved);
  lastWebTemplateId = resolved.template.id;
  const { place, canvas, template } = resolved;
  return {
    viewportWidth,
    viewportHeight,
    frameWidth: place.frameWidth,
    frameHeight: place.frameHeight,
    frameLeft: place.frameLeft,
    frameTop: place.frameTop,
    frameRight: place.frameLeft + place.frameWidth,
    frameBottom: place.frameTop + place.frameHeight,
    cropOffsetX: place.cropX,
    cropOffsetY: place.cropY,
    step: canvas.step,
    stepFine: canvas.stepFine,
    templateId: template.id
  };
}

export function snapToGrid(value: number, origin: number, step: number): number {
  return origin + Math.round((value - origin) / step) * step;
}

export function applyViewportFrameCssVars(frame: ViewportFrame, target?: HTMLElement) {
  const host = target ?? document.documentElement;
  const resolved = resolveWebGridFrame(frame.viewportWidth, frame.viewportHeight, frame.templateId);
  applyWebGridFrameCssVars(host, resolved);
}

export function useViewportFrameCssVars(enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const sync = () => {
      applyViewportFrameCssVars(getViewportFrame());
    };
    const vv = window.visualViewport;

    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync);

    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
    };
  }, [enabled]);
}
