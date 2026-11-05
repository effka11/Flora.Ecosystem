import { describe, expect, it } from "vitest";
import { FLORA_THEME_TOKENS } from "./floraThemeTokens.js";
import { profileInitials } from "./profileInitials.js";
import { resolveDefaultAvatarColor, resolveDefaultAvatarColorId } from "./resolveDefaultAvatarColor.js";

describe("profileInitials", () => {
  it("uses display name when long enough", () => {
    expect(profileInitials("Anna Moroz", "anna_m")).toBe("AN");
  });

  it("falls back to username", () => {
    expect(profileInitials("", "boris_krav")).toBe("BO");
  });
});

describe("resolveDefaultAvatarColor", () => {
  it("always uses graphite for default avatars", () => {
    expect(resolveDefaultAvatarColorId("any-user")).toBe("forest");
    expect(resolveDefaultAvatarColor("any-user")).toBe("#303132");
    expect(resolveDefaultAvatarColor("")).toBe("#303132");
  });
});

describe("FLORA_THEME_TOKENS", () => {
  it("matches web globals.css core palette", () => {
    expect(FLORA_THEME_TOKENS.bg).toBe("#0a0a0a");
    expect(FLORA_THEME_TOKENS.whiteTemplate).toBe("#dde2e8");
    expect(FLORA_THEME_TOKENS.textSecondary).toBe("#b3b7bc");
    expect(FLORA_THEME_TOKENS.greenLight).toBe("#dde2e8");
    expect(FLORA_THEME_TOKENS.greenDark).toBe("#303132");
    expect(FLORA_THEME_TOKENS.signal).toBe("#ff9688");
    expect(FLORA_THEME_TOKENS.reserveSubstrateTemplate).toBe("#1b1b1c");
    expect(FLORA_THEME_TOKENS.reserveSubstrateGrayMuted).toBe("#1c1c1c");
    expect(FLORA_THEME_TOKENS.reservePopoverInset).toBe("#1b1b1c");
    expect(FLORA_THEME_TOKENS.reservePopoverDivider).toBe("#232425");
    expect(FLORA_THEME_TOKENS.reserveHoverSurface).toBe("#1b1b1c");
    expect(FLORA_THEME_TOKENS.reserveHoverOnSurfaceThem).toBe("#212222");
    expect(FLORA_THEME_TOKENS.gray).toBe("#979a9e");
    expect(FLORA_THEME_TOKENS.grayDivider).toBe("#1e1e1f");
    expect(FLORA_THEME_TOKENS.messagesBubbleThemBg).toBe("#232324");
    expect(FLORA_THEME_TOKENS.messagesBubbleThemText).toBe("#c5c9ce");
    expect(FLORA_THEME_TOKENS.messagesBubbleThemTime).toBe("#a3a6ab");
  });
});
