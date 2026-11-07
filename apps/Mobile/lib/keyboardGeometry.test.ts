import { describe, expect, it } from "vitest";
import { keyboardHeightForDock, reconciledKeyboardGeometry } from "./keyboardGeometry";

const base = {
  visible: true,
  nativeHeightPx: 300,
  currentHeightPx: 0,
  currentProgress: 0,
};

describe("reconciledKeyboardGeometry", () => {
  it("lifts a stale zero height when the keyboard is actually visible", () => {
    expect(reconciledKeyboardGeometry(base)).toEqual({ heightPx: -300, progress: 1 });
  });

  it("does not touch geometry that already matches the native keyboard", () => {
    expect(
      reconciledKeyboardGeometry({ ...base, currentHeightPx: -300, currentProgress: 1 }),
    ).toBeNull();
  });

  it("deepens a partial height left over by a missed animation", () => {
    expect(
      reconciledKeyboardGeometry({ ...base, currentHeightPx: -120, currentProgress: 0.4 }),
    ).toEqual({ heightPx: -300, progress: 1 });
  });

  it("ignores a visible event without a usable height", () => {
    expect(reconciledKeyboardGeometry({ ...base, nativeHeightPx: 1 })).toBeNull();
  });

  it("drops a stuck lift after the keyboard is gone", () => {
    expect(
      reconciledKeyboardGeometry({
        visible: false,
        nativeHeightPx: 0,
        currentHeightPx: -300,
        currentProgress: 1,
      }),
    ).toEqual({ heightPx: 0, progress: 0 });
  });

  it("keeps an already idle dock untouched", () => {
    expect(
      reconciledKeyboardGeometry({
        visible: false,
        nativeHeightPx: 0,
        currentHeightPx: 0,
        currentProgress: 0,
      }),
    ).toBeNull();
  });
});

describe("keyboardHeightForDock", () => {
  it("adds the translucent navigation bar back on Android", () => {
    // RN отдаёт ime.bottom - systemBars.bottom, провайдер — ime.bottom целиком:
    // без поправки док встанет на navInset ниже клавиатуры.
    expect(
      keyboardHeightForDock({ android: true, eventHeightPx: 280, navInsetPx: 24 }),
    ).toBe(304);
  });

  it("keeps the iOS keyboard frame as is", () => {
    expect(
      keyboardHeightForDock({ android: false, eventHeightPx: 336, navInsetPx: 34 }),
    ).toBe(336);
  });

  it("never returns a negative height and ignores a negative inset", () => {
    expect(
      keyboardHeightForDock({ android: true, eventHeightPx: -5, navInsetPx: -24 }),
    ).toBe(0);
  });
});
