import { describe, expect, it } from "vitest";
import {
  countryFlagEmoji,
  formatPhoneDraft,
  formatPhoneDraftFromInput,
  isPhoneInputAtRegionLimit,
  phoneDisplayFromStored,
  phoneDraftEqualsStored,
} from "./phoneNumber";

describe("phoneNumber", () => {
  it("formats RU mobile with spaces and detects country", () => {
    const draft = formatPhoneDraft("+79001234567");
    expect(draft.country).toBe("RU");
    expect(draft.display.startsWith("+")).toBe(true);
    expect(draft.display.includes(" ")).toBe(true);
    expect(draft.e164).toBe("+79001234567");
    expect(countryFlagEmoji(draft.country)).toBe("🇷🇺");
  });

  it("prefixes plus for any digit sequence including leading 8", () => {
    expect(formatPhoneDraft("7900").display.startsWith("+")).toBe(true);
    expect(formatPhoneDraft("8900").display.startsWith("+")).toBe(true);
    expect(formatPhoneDraft("8900").digits.startsWith("+")).toBe(true);
  });

  it("does not treat leading 8 as Russian national", () => {
    const draft = formatPhoneDraft("89001234567");
    expect(draft.display.startsWith("+")).toBe(true);
    expect(draft.country).not.toBe("RU");
    expect(draft.e164).not.toBe("+79001234567");
  });

  it("uses only spaces as separators (no parens or dashes)", () => {
    const with8 = formatPhoneDraft("89001234567");
    const intl = formatPhoneDraft("+79001234567");
    for (const draft of [with8, intl]) {
      expect(draft.display.includes("(")).toBe(false);
      expect(draft.display.includes(")")).toBe(false);
      expect(draft.display.includes("-")).toBe(false);
    }
  });

  it("removes lone plus when there are no digits after it", () => {
    expect(formatPhoneDraft("+")).toEqual({
      display: "",
      country: undefined,
      e164: null,
      digits: "",
    });
    expect(formatPhoneDraft("+ ")).toEqual({
      display: "",
      country: undefined,
      e164: null,
      digits: "",
    });
  });

  it("rejects digits beyond region max length (RU international)", () => {
    const ok = formatPhoneDraft("+79001234567");
    expect(ok.e164).toBe("+79001234567");
    expect(isPhoneInputAtRegionLimit(ok.display)).toBe(true);
    const over = formatPhoneDraft("+7900123456789");
    expect(over.e164).toBe("+79001234567");
    expect(over.digits.replace(/\D/g, "")).toBe("79001234567");
  });

  it("does not mark incomplete number as at region limit", () => {
    expect(isPhoneInputAtRegionLimit("+7900")).toBe(false);
  });

  it("treats backspace on trailing space as deleting last digit", () => {
    const draft = formatPhoneDraftFromInput("+8 900 ", "+8 900 1");
    expect(draft.digits.replace(/\D/g, "")).toBe("8900");
    expect(draft.display.startsWith("+")).toBe(true);
  });

  it("does not strip digits when formatter echoes digit-only raw", () => {
    const previous = formatPhoneDraft("8900").display;
    const draft = formatPhoneDraftFromInput("8900", previous);
    expect(draft.display).toBe(previous);
  });

  it("keeps plus and spaces while typing leading 8", () => {
    let display = "";
    for (const digit of "89001234567") {
      display = formatPhoneDraftFromInput(display + digit, display).display;
    }
    expect(display.startsWith("+")).toBe(true);
    expect(display.includes("(")).toBe(false);
    expect(display.includes("-")).toBe(false);
  });

  it("still allows incomplete numbers shorter than max", () => {
    const draft = formatPhoneDraft("+7900");
    expect(draft.display.startsWith("+7")).toBe(true);
    expect(draft.digits.replace(/\D/g, "")).toBe("7900");
  });

  it("shows US flag as soon as calling code 1 is typed", () => {
    expect(formatPhoneDraft("1").country).toBe("US");
    expect(formatPhoneDraft("+1").country).toBe("US");
    expect(formatPhoneDraft("+12").country).toBe("US");
    expect(countryFlagEmoji(formatPhoneDraft("1").country)).toBe("🇺🇸");
  });

  it("formats US number", () => {
    const draft = formatPhoneDraft("+12133734253");
    expect(draft.country).toBe("US");
    expect(countryFlagEmoji(draft.country)).toBe("🇺🇸");
    expect(draft.e164).toBe("+12133734253");
  });

  it("compares stored vs formatted draft ignoring spaces", () => {
    const stored = "+79001234567";
    const draft = formatPhoneDraft("+7 900 123-45-67");
    expect(phoneDraftEqualsStored(draft, stored)).toBe(true);
  });

  it("loads stored into international display", () => {
    const draft = phoneDisplayFromStored("+79001234567");
    expect(draft.country).toBe("RU");
    expect(draft.display.startsWith("+")).toBe(true);
  });
});
