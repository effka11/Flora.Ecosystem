import { describe, expect, it } from "vitest";
import { FLORA_THEME_TOKENS } from "@flora/client-core/display";
import {
  DEFAULT_FLORA_THEME_ID,
  FLORA_THEMES,
  FLORA_THEME_IDS,
  floraTokenAlpha,
  isFloraThemeId,
} from "./floraTheme";

describe("floraTheme", () => {
  it("exposes exactly the three Android themes in order", () => {
    expect(FLORA_THEME_IDS).toEqual(["dark", "light", "flora"]);
    expect(FLORA_THEME_IDS.map((id) => FLORA_THEMES[id].label)).toEqual([
      "Тёмная",
      "Светлая",
      "Flora (старая)",
    ]);
  });

  it("defaults to the neutral dark theme", () => {
    expect(DEFAULT_FLORA_THEME_ID).toBe("dark");
    expect(FLORA_THEMES.dark.palette).toEqual(FLORA_THEME_TOKENS);
  });

  it.each(FLORA_THEME_IDS)("palette %s covers every client-core token as hex", (themeId) => {
    const palette = FLORA_THEMES[themeId].palette;
    expect(Object.keys(palette).sort()).toEqual(Object.keys(FLORA_THEME_TOKENS).sort());
    for (const value of Object.values(palette)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps light and legacy accents distinct from the current dark theme", () => {
    expect(FLORA_THEMES.light.palette.bg).not.toBe(FLORA_THEMES.dark.palette.bg);
    expect(FLORA_THEMES.light.palette.greenLight).not.toBe(FLORA_THEMES.dark.palette.greenLight);
    expect(FLORA_THEMES.flora.palette.greenLight).toBe("#a4d18a");
    expect(FLORA_THEMES.light.isDark).toBe(false);
    expect(FLORA_THEMES.flora.isDark).toBe(true);
  });

  it("normalizes stored theme ids", () => {
    expect(isFloraThemeId("light")).toBe(true);
    expect(isFloraThemeId("flora")).toBe(true);
    expect(isFloraThemeId("midnight")).toBe(false);
    expect(isFloraThemeId(null)).toBe(false);
  });

  it("builds overlay rgba from the palette template", () => {
    expect(floraTokenAlpha("#dde2e8", 0.08)).toBe("rgba(221, 226, 232, 0.08)");
    expect(floraTokenAlpha("#0a0a0a", 0.55)).toBe("rgba(10, 10, 10, 0.55)");
  });

  it.each(FLORA_THEME_IDS)("keeps readable contrast in the %s palette", (themeId) => {
    const palette = FLORA_THEMES[themeId].palette;
    expect(contrastRatio(palette.whiteTemplate, palette.bg)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(palette.greenLight, palette.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.textSecondary, palette.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.gray, palette.bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette.signal, palette.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
