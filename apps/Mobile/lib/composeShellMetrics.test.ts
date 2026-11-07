import { describe, expect, it } from "vitest";
import { composeShellMetrics } from "./composeShellMetrics";

const LINE = 22;

describe("composeShellMetrics", () => {
  it("keeps a single-line shell as the baseline without attachments", () => {
    expect(
      composeShellMetrics({ height: 76, rows: 1, mediaPresent: false, mediaHeight: 0, lineHeight: LINE }),
    ).toEqual({ height: 76, mediaHeight: null, baseHeight: 76 });
  });

  it("strips already grown rows out of the single-line baseline", () => {
    expect(
      composeShellMetrics({ height: 98, rows: 2, mediaPresent: false, mediaHeight: 0, lineHeight: LINE }),
    ).toEqual({ height: 98, mediaHeight: null, baseHeight: 76 });
  });

  it("subtracts a measured attachment strip from the baseline", () => {
    expect(
      composeShellMetrics({ height: 140, rows: 1, mediaPresent: true, mediaHeight: 64, lineHeight: LINE }),
    ).toEqual({ height: 140, mediaHeight: 64, baseHeight: 76 });
  });

  it("reports no baseline while the strip is present but unmeasured", () => {
    expect(
      composeShellMetrics({ height: 140, rows: 1, mediaPresent: true, mediaHeight: 0, lineHeight: LINE }),
    ).toEqual({ height: 140, mediaHeight: 0, baseHeight: null });
  });

  it("combines strip and grown rows without absorbing either into the baseline", () => {
    expect(
      composeShellMetrics({ height: 162, rows: 2, mediaPresent: true, mediaHeight: 64, lineHeight: LINE }),
    ).toEqual({ height: 162, mediaHeight: 64, baseHeight: 76 });
  });

  it("reports nothing for an unmeasured shell", () => {
    expect(
      composeShellMetrics({ height: 0, rows: 1, mediaPresent: false, mediaHeight: 0, lineHeight: LINE }),
    ).toEqual({ height: 0, mediaHeight: null, baseHeight: null });
  });
});
