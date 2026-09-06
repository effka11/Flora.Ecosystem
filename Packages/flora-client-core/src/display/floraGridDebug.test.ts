import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeFloraGridDebug,
  reportFloraGridDebug,
  resetFloraGridDebugState,
  takeFloraGridDebugView
} from "./floraGridDebug.js";
import { gridCanvasSize, pickGridTemplate, placeGridCanvas } from "./floraGridTemplates.js";

afterEach(() => {
  resetFloraGridDebugState();
  delete (globalThis as { __FLORA_GRID_DEBUG__?: unknown }).__FLORA_GRID_DEBUG__;
  vi.restoreAllMocks();
});

function webSnapshot(width: number, height: number, previousId?: string | null) {
  const chosen = pickGridTemplate({ family: "web", width, height, previousId });
  const fitted = pickGridTemplate({ family: "web", width, height });
  const canvas = gridCanvasSize(chosen);
  const place = placeGridCanvas({ viewportW: width, viewportH: height, canvas });
  return {
    family: "web" as const,
    width,
    height,
    previousId,
    chosen,
    fitted,
    canvas,
    place
  };
}

function mobileSnapshot(width: number, height: number, previousId?: string | null) {
  const chosen = pickGridTemplate({ family: "mobile", width, height, previousId });
  const fitted = pickGridTemplate({ family: "mobile", width, height });
  return {
    family: "mobile" as const,
    width,
    height,
    previousId,
    chosen,
    fitted,
    canvas: gridCanvasSize(chosen)
  };
}

describe("describeFloraGridDebug", () => {
  it("marks boot + letterbox at 1920×1080", () => {
    const view = describeFloraGridDebug(webSnapshot(1920, 1080));
    expect(view.reason).toBe("boot");
    expect(view.headline).toContain("web-1");
    expect(view.lines.some((l) => l.value.includes("letterbox"))).toBe(true);
  });

  it("marks switch-up at 2560×1440", () => {
    const prev = pickGridTemplate({ family: "web", width: 1920, height: 945 });
    const view = describeFloraGridDebug(webSnapshot(2560, 1440, prev.id));
    expect(view.reason).toBe("up");
    expect(view.headline).toContain("web-1 → web-1-2");
  });

  it("marks hysteresis hold at 2304−17 and drop at 2304−18", () => {
    const prev = pickGridTemplate({ family: "web", width: 2304, height: 1134 });
    const hold = describeFloraGridDebug(webSnapshot(2304 - 17, 1134, prev.id));
    expect(hold.reason).toBe("hold");
    expect(hold.lines.some((l) => l.label === "влез бы")).toBe(true);

    const drop = describeFloraGridDebug(webSnapshot(2304 - 18, 1134, prev.id));
    expect(drop.reason).toBe("down");
  });

  it("is idle when the template and frame mode stay put", () => {
    const prev = pickGridTemplate({ family: "web", width: 1920, height: 1080 });
    const view = describeFloraGridDebug(webSnapshot(1920, 1080, prev.id));
    expect(view.reason).toBe("idle");
  });

  it("marks mobile boot at 390 and hold below 768", () => {
    const boot = describeFloraGridDebug(mobileSnapshot(390, 844));
    expect(boot.reason).toBe("boot");
    expect(boot.headline).toContain("mobile-1");

    const prev = pickGridTemplate({ family: "mobile", width: 800, height: 1280 });
    const hold = describeFloraGridDebug(mobileSnapshot(768 - 17, 1280, prev.id));
    expect(hold.reason).toBe("hold");
    expect(hold.headline).toContain("mobile-1-2");
  });
});

describe("takeFloraGridDebugView", () => {
  it("logs mobile rotation as size when the template stays put", () => {
    const boot = takeFloraGridDebugView(mobileSnapshot(360, 780));
    expect(boot?.reason).toBe("boot");

    const prev = pickGridTemplate({ family: "mobile", width: 360, height: 780 });
    expect(takeFloraGridDebugView(mobileSnapshot(360, 780, prev.id))).toBeNull();

    const rotated = takeFloraGridDebugView(mobileSnapshot(780, 360, prev.id));
    expect(rotated?.reason).toBe("size");
    expect(rotated?.reasonLabel).toBe("окно");
    expect(rotated?.lines.some((l) => l.value.includes("780 × 360"))).toBe(true);
  });
});

describe("reportFloraGridDebug", () => {
  it("prints boot once via console.warn, then skips the same signature", () => {
    (globalThis as { __FLORA_GRID_DEBUG__?: unknown }).__FLORA_GRID_DEBUG__ = true;
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const snap = webSnapshot(1920, 1080);
    reportFloraGridDebug(snap);
    const callsAfterBoot = log.mock.calls.length;
    expect(callsAfterBoot).toBeGreaterThan(0);

    reportFloraGridDebug(snap);
    expect(log.mock.calls.length).toBe(callsAfterBoot);
  });
});
