import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { FgceEngine } from "../src/engine";

const wasmPath = process.env.FGCE_WASM_PATH;
const smoke = wasmPath ? it : it.skip;

describe("wasm smoke", () => {
  smoke("begin, fill, end and read pixels", async () => {
    const bytes = new Uint8Array(await readFile(wasmPath as string));
    const engine = await FgceEngine.load(new Response(bytes));
    try {
      expect(engine.info().version).toBe("0.2.0");
      engine.begin(4, 4);
      engine.fillRect(
        { x1: 0, y1: 0, x2: 3, y2: 3 },
        { r: 255, g: 255, b: 255, a: 255 },
      );
      const frame = engine.end();
      expect(frame.width).toBe(4);
      expect(frame.height).toBe(4);
      expect(frame.stride).toBe(64);
      expect(Array.from(frame.pixels.subarray(0, 4))).toEqual([255, 255, 255, 255]);

      const pixels = engine.readPixels({ x1: 0, y1: 0, x2: 0, y2: 0 }, "straight");
      expect(pixels.stride).toBe(4);
      expect(Array.from(pixels.bytes)).toEqual([255, 255, 255, 255]);

      engine.begin(8, 8);
      engine.entity(
        1,
        { kind: "flat", color: { r: 10, g: 20, b: 30, a: 255 } },
        {
          x1: { kind: "pixel", value: 0 },
          y1: { kind: "pixel", value: 0 },
          x2: { kind: "pixel", value: 7 },
          y2: { kind: "pixel", value: 7 },
        },
        { onGrid: false },
      );
      const snapshot = engine.snapshot();
      expect(snapshot.nodes).toEqual([
        { id: 1, parent: 0, rect: { x1: 0, y1: 0, x2: 7, y2: 7 } },
      ]);
    } finally {
      engine.destroy();
    }
  });
});
