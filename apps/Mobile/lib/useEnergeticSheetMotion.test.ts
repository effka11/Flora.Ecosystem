import { describe, expect, it } from "vitest";
import {
  sheetCloseFalling,
  sheetFirstPaintProgress,
  sheetOpenRising,
  sheetShouldCommitClose,
  sheetShouldPresent,
} from "./energeticSheetMotion";

describe("sheetFirstPaintProgress", () => {
  it("arms the first frame off-screen like chat push", () => {
    expect(sheetFirstPaintProgress(false)).toBe(0);
  });

  it("skips motion by landing on-screen", () => {
    expect(sheetFirstPaintProgress(true)).toBe(1);
  });
});

describe("sheetShouldPresent", () => {
  it("stays mounted while open", () => {
    expect(sheetShouldPresent(true, false)).toBe(true);
  });

  it("stays mounted through the close animation", () => {
    expect(sheetShouldPresent(false, true)).toBe(true);
  });

  it("unmounts only when both idle", () => {
    expect(sheetShouldPresent(false, false)).toBe(false);
  });
});

describe("sheetOpenRising / sheetCloseFalling", () => {
  it("opens from idle and from a completed close", () => {
    expect(sheetOpenRising(null, true)).toBe(true);
    expect(sheetOpenRising(false, true)).toBe(true);
    expect(sheetOpenRising(true, true)).toBe(false);
  });

  it("closes only on a falling edge", () => {
    expect(sheetCloseFalling(true, false)).toBe(true);
    expect(sheetCloseFalling(false, false)).toBe(false);
    expect(sheetCloseFalling(null, false)).toBe(false);
  });
});

describe("sheetShouldCommitClose", () => {
  it("always commits when the sheet is still closing", () => {
    expect(sheetShouldCommitClose(false)).toBe(true);
  });

  it("does not unmount if open won during close", () => {
    expect(sheetShouldCommitClose(true)).toBe(false);
  });
});
