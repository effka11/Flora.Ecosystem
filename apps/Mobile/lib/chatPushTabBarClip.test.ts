import { describe, expect, it } from "vitest";
import {
  tabBarMaskProgress,
  tabBarMaskTranslateXPx,
  uncoveredWidthPx,
} from "./chatPushTabBarClip";

const SCREEN = 390;

describe("uncoveredWidthPx", () => {
  it("is the full screen at rest (p = 0)", () => {
    expect(uncoveredWidthPx(0, SCREEN)).toBe(SCREEN);
  });

  it("is half the screen at mid-slide (p = 0.5)", () => {
    expect(uncoveredWidthPx(0.5, SCREEN)).toBe(SCREEN / 2);
  });

  it("is 0 when the chat covers the screen (p = 1)", () => {
    expect(uncoveredWidthPx(1, SCREEN)).toBe(0);
  });

  it("clamps progress outside 0…1", () => {
    expect(uncoveredWidthPx(-0.2, SCREEN)).toBe(SCREEN);
    expect(uncoveredWidthPx(1.4, SCREEN)).toBe(0);
  });

  it("is 0 when the screen width is not positive", () => {
    expect(uncoveredWidthPx(0, 0)).toBe(0);
    expect(uncoveredWidthPx(0.5, -10)).toBe(0);
  });
});

describe("tabBarMaskTranslateXPx", () => {
  it("keeps the full-width mask on-screen at rest", () => {
    expect(tabBarMaskTranslateXPx(0, SCREEN)).toBe(0);
  });

  it("shifts the mask left by half a screen at mid-slide", () => {
    expect(tabBarMaskTranslateXPx(0.5, SCREEN)).toBe(-SCREEN / 2);
  });

  it("shifts the mask fully off the left edge when the chat covers", () => {
    expect(tabBarMaskTranslateXPx(1, SCREEN)).toBe(-SCREEN);
  });
});

describe("tabBarMaskProgress", () => {
  it("keeps the bar hidden for the whole open thread", () => {
    // Возврат из пикера мог сбросить progress под живым тредом: бар всё равно
    // не должен рисоваться над полем ввода.
    expect(
      tabBarMaskProgress({ threadOpen: true, chatProgress: 0, composeProgress: 0 }),
    ).toBe(1);
  });

  it("follows the slide when no thread route is open", () => {
    expect(
      tabBarMaskProgress({ threadOpen: false, chatProgress: 0.4, composeProgress: 0 }),
    ).toBe(0.4);
    expect(
      tabBarMaskProgress({ threadOpen: false, chatProgress: 0, composeProgress: 0.7 }),
    ).toBe(0.7);
  });
});
