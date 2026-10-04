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
  it("always uses dark green for default avatars", () => {
    expect(resolveDefaultAvatarColorId("any-user")).toBe("forest");
    expect(resolveDefaultAvatarColor("any-user")).toBe("#2c3527");
    expect(resolveDefaultAvatarColor("")).toBe("#2c3527");
  });
});

describe("FLORA_THEME_TOKENS", () => {
  it("matches web globals.css core palette", () => {
    expect(FLORA_THEME_TOKENS.bg).toBe("#0c0c0c");
    expect(FLORA_THEME_TOKENS.greenLight).toBe("#a4d18a");
    expect(FLORA_THEME_TOKENS.greenDark).toBe("#2c3527");
    expect(FLORA_THEME_TOKENS.reserveHoverSurface).toBe("#1f1f1f");
    expect(FLORA_THEME_TOKENS.messagesBubbleThemBg).toBe("#1e241d");
  });
});
