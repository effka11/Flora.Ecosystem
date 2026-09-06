import { describe, expect, it } from "vitest";
import {
  FLORA_GRID_WEB_BASE_HEIGHT,
  FLORA_GRID_WEB_BASE_WIDTH,
  gridCanvasSize,
  pickGridTemplate,
  placeGridCanvas
} from "./floraGridTemplates.js";

describe("gridCanvasSize", () => {
  it("keeps integer steps at s=1 and s=1.2", () => {
    const s1 = gridCanvasSize(pickGridTemplate({ family: "web", width: 1920, height: 945 }));
    expect(s1.step).toBe(15);
    expect(s1.stepFine).toBe(5);
    expect(s1.width).toBe(1920);
    expect(s1.height).toBe(945);
    expect(s1.cols).toBe(128);
    expect(s1.rows).toBe(63);

    const s12 = gridCanvasSize(
      pickGridTemplate({ family: "web", width: 2304, height: 1134 })
    );
    expect(s12.step).toBe(18);
    expect(s12.stepFine).toBe(6);
    expect(s12.width).toBe(2304);
    expect(s12.height).toBe(1134);
  });
});

describe("pickGridTemplate web", () => {
  it("selects s=1 at 1920×945", () => {
    expect(pickGridTemplate({ family: "web", width: 1920, height: 945 }).s).toBe(1);
  });

  it("keeps s=1 with letterbox at 1920×1080", () => {
    const t = pickGridTemplate({ family: "web", width: 1920, height: 1080 });
    expect(t.s).toBe(1);
    const canvas = gridCanvasSize(t);
    const place = placeGridCanvas({
      viewportW: 1920,
      viewportH: 1080,
      canvas
    });
    expect(place.cropX).toBe(0);
    expect(place.cropY).toBe(0);
    expect(place.top).toBe(Math.round((1080 - 945) / 2));
  });

  it("selects s=1.2 at 2560×1440", () => {
    expect(pickGridTemplate({ family: "web", width: 2560, height: 1440 }).s).toBe(1.2);
  });

  it("selects s=2 at 3840×2160", () => {
    expect(pickGridTemplate({ family: "web", width: 3840, height: 2160 }).s).toBe(2);
  });

  it("selects s=0.6 at 1366×768", () => {
    const t = pickGridTemplate({ family: "web", width: 1366, height: 768 });
    expect(t.s).toBe(0.6);
    const canvas = gridCanvasSize(t);
    const place = placeGridCanvas({
      viewportW: 1366,
      viewportH: 768,
      canvas
    });
    expect(place.cropX).toBe(0);
    expect(place.cropY).toBe(0);
  });

  it("holds s=1.2 with hysteresis at 2304−17, drops at 2304−18", () => {
    const prev = pickGridTemplate({ family: "web", width: 2304, height: 1134 });
    expect(prev.s).toBe(1.2);
    const hold = pickGridTemplate({
      family: "web",
      width: 2304 - 17,
      height: 1134,
      previousId: prev.id
    });
    expect(hold.s).toBe(1.2);
    const drop = pickGridTemplate({
      family: "web",
      width: 2304 - 18,
      height: 1134,
      previousId: prev.id
    });
    expect(drop.s).toBe(1);
  });

  it("crops when below min template", () => {
    const t = pickGridTemplate({ family: "web", width: 800, height: 400 });
    expect(t.s).toBe(0.6);
    const canvas = gridCanvasSize(t);
    const place = placeGridCanvas({
      viewportW: 800,
      viewportH: 400,
      canvas
    });
    expect(place.cropX).toBeGreaterThan(0);
    expect(place.cropY).toBeGreaterThan(0);
    expect(place.left).toBe(Math.round(0 - place.cropX));
  });
});

describe("pickGridTemplate mobile", () => {
  it("selects s=1 at 390", () => {
    expect(pickGridTemplate({ family: "mobile", width: 390, height: 844 }).s).toBe(1);
  });

  it("selects s=1.2 at min-side 800", () => {
    expect(pickGridTemplate({ family: "mobile", width: 800, height: 1280 }).s).toBe(1.2);
  });

  it("selects s=1.4 at min-side 1024", () => {
    expect(pickGridTemplate({ family: "mobile", width: 1024, height: 1366 }).s).toBe(1.4);
  });

  it("holds s=1.2 with hysteresis at 768−17, drops at 768−18", () => {
    const prev = pickGridTemplate({ family: "mobile", width: 800, height: 1280 });
    expect(prev.s).toBe(1.2);
    const hold = pickGridTemplate({
      family: "mobile",
      width: 768 - 17,
      height: 1280,
      previousId: prev.id
    });
    expect(hold.s).toBe(1.2);
    const drop = pickGridTemplate({
      family: "mobile",
      width: 768 - 18,
      height: 1280,
      previousId: prev.id
    });
    expect(drop.s).toBe(1);
  });
});

describe("placeGridCanvas", () => {
  it("centers the s=1 canvas in a taller viewport", () => {
    const place = placeGridCanvas({
      viewportW: FLORA_GRID_WEB_BASE_WIDTH,
      viewportH: 1080,
      canvas: { width: FLORA_GRID_WEB_BASE_WIDTH, height: FLORA_GRID_WEB_BASE_HEIGHT }
    });
    expect(place.cropX).toBe(0);
    expect(place.cropY).toBe(0);
    expect(place.left).toBe(0);
    expect(place.top).toBe(Math.round((1080 - FLORA_GRID_WEB_BASE_HEIGHT) / 2));
  });
});

describe("3×grid slot", () => {
  it("is 45 at s=1 and 54 at s=1.2", () => {
    const phone = gridCanvasSize(
      pickGridTemplate({ family: "mobile", width: 390, height: 844 })
    );
    const tablet = gridCanvasSize(
      pickGridTemplate({ family: "mobile", width: 800, height: 1280 })
    );
    expect(3 * phone.step).toBe(45);
    expect(3 * tablet.step).toBe(54);
  });
});
