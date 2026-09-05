import assert from "node:assert/strict";
import test from "node:test";
import {
  destBackingSize,
  objectFitDrawRect,
  parseObjectFit,
  parseObjectPosition,
} from "./frcCanvasPaint";

test("destBackingSize uses bitmap size when CSS box is zero", () => {
  assert.deepEqual(destBackingSize(0, 0, 2, 2048, 1024), { width: 2048, height: 1024 });
  assert.deepEqual(destBackingSize(0, 45, 2, 800, 600), { width: 800, height: 600 });
  assert.deepEqual(destBackingSize(45, 0, 3, 800, 600), { width: 800, height: 600 });
});

test("destBackingSize scales CSS box by DPR", () => {
  assert.deepEqual(destBackingSize(45, 45, 2, 2048, 2048), { width: 90, height: 90 });
  assert.deepEqual(destBackingSize(45, 45, 1, 2048, 2048), { width: 45, height: 45 });
  assert.deepEqual(destBackingSize(330, 220, 2, 2048, 1365), { width: 660, height: 440 });
});

test("destBackingSize does not exceed the source, preserving CSS aspect", () => {
  // 400×400 CSS at 2× would be 800×800; bitmap is 200×100 → cap 0.125 → 100×100.
  assert.deepEqual(destBackingSize(400, 400, 2, 200, 100), { width: 100, height: 100 });
  assert.deepEqual(destBackingSize(200, 100, 1, 200, 100), { width: 200, height: 100 });
});

test("parseObjectFit maps known values and defaults to fill", () => {
  assert.equal(parseObjectFit("cover"), "cover");
  assert.equal(parseObjectFit(" contain "), "contain");
  assert.equal(parseObjectFit("SCALE-DOWN"), "scale-down");
  assert.equal(parseObjectFit(""), "fill");
  assert.equal(parseObjectFit("auto"), "fill");
});

test("parseObjectPosition reads percent and keywords", () => {
  assert.deepEqual(parseObjectPosition("50% 50%"), { x: 0.5, y: 0.5 });
  assert.deepEqual(parseObjectPosition("0% 100%"), { x: 0, y: 1 });
  assert.deepEqual(parseObjectPosition("left top"), { x: 0, y: 0 });
  assert.deepEqual(parseObjectPosition("bottom right"), { x: 1, y: 1 });
  assert.deepEqual(parseObjectPosition("center"), { x: 0.5, y: 0.5 });
  assert.deepEqual(parseObjectPosition(""), { x: 0.5, y: 0.5 });
});

test("objectFitDrawRect fill stretches to dest", () => {
  const rect = objectFitDrawRect(200, 100, 50, 50, "fill");
  assert.deepEqual(rect, { sx: 0, sy: 0, sw: 200, sh: 100, dx: 0, dy: 0, dw: 50, dh: 50 });
});

test("objectFitDrawRect cover crops the source, centered", () => {
  const rect = objectFitDrawRect(200, 100, 50, 50, "cover");
  assert.equal(rect.dx, 0);
  assert.equal(rect.dy, 0);
  assert.equal(rect.dw, 50);
  assert.equal(rect.dh, 50);
  assert.equal(rect.sh, 100);
  assert.equal(rect.sw, 100);
  assert.equal(rect.sx, 50);
  assert.equal(rect.sy, 0);
});

test("objectFitDrawRect contain letterboxes, centered", () => {
  const rect = objectFitDrawRect(200, 100, 50, 50, "contain");
  assert.equal(rect.sx, 0);
  assert.equal(rect.sy, 0);
  assert.equal(rect.sw, 200);
  assert.equal(rect.sh, 100);
  assert.equal(rect.dw, 50);
  assert.equal(rect.dh, 25);
  assert.equal(rect.dx, 0);
  assert.equal(rect.dy, 13);
});

test("objectFitDrawRect contain honors object-position left", () => {
  const rect = objectFitDrawRect(100, 200, 50, 50, "contain", { x: 0, y: 0.5 });
  assert.equal(rect.dw, 25);
  assert.equal(rect.dh, 50);
  assert.equal(rect.dx, 0);
  assert.equal(rect.dy, 0);
});
