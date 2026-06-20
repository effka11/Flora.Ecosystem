"use client";

import { useEffect } from "react";

export const FLORA_BASE_WIDTH = 1920;
export const FLORA_BASE_HEIGHT = 945;

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
};

type ViewportSize = {
  width: number;
  height: number;
};

function getViewportSize(): ViewportSize {
  if (typeof window === "undefined") {
    return { width: FLORA_BASE_WIDTH, height: FLORA_BASE_HEIGHT };
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
  const frameWidth = Math.min(viewportWidth, FLORA_BASE_WIDTH);
  const frameHeight = Math.min(viewportHeight, FLORA_BASE_HEIGHT);
  const frameLeft = (viewportWidth - frameWidth) / 2;
  const frameTop = (viewportHeight - frameHeight) / 2;

  return {
    viewportWidth,
    viewportHeight,
    frameWidth,
    frameHeight,
    frameLeft,
    frameTop,
    frameRight: frameLeft + frameWidth,
    frameBottom: frameTop + frameHeight,
    cropOffsetX: Math.max(0, (FLORA_BASE_WIDTH - frameWidth) / 2),
    cropOffsetY: Math.max(0, (FLORA_BASE_HEIGHT - frameHeight) / 2)
  };
}

export function snapToGrid(value: number, origin: number, step: number): number {
  return origin + Math.round((value - origin) / step) * step;
}

export function applyViewportFrameCssVars(frame: ViewportFrame, target?: HTMLElement) {
  const host = target ?? document.documentElement;
  host.style.setProperty("--flora-frame-width", `${frame.frameWidth}px`);
  host.style.setProperty("--flora-frame-height", `${frame.frameHeight}px`);
  host.style.setProperty("--flora-frame-left", `${frame.frameLeft}px`);
  host.style.setProperty("--flora-frame-top", `${frame.frameTop}px`);
  host.style.setProperty("--flora-crop-x", `${frame.cropOffsetX}px`);
  host.style.setProperty("--flora-crop-y", `${frame.cropOffsetY}px`);
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
