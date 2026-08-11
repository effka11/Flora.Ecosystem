import { describe, expect, it } from "vitest";
import {
  acceptsFrcI,
  FRC_I_BITSTREAM_VERSION,
  FRC_I_EXTENSION,
  FRC_I_MIME,
  FRC_I_WASM_ABI_VERSION,
} from "../src/index";

describe("FRC-I integration contracts", () => {
  it("keeps the current wire gate and MIME constants", () => {
    // FRC_I_BITSTREAM_VERSION == frc_i::BITSTREAM_VERSION (wasm high byte after predev).
    expect(FRC_I_BITSTREAM_VERSION).toBe(11);
    expect(FRC_I_WASM_ABI_VERSION).toBe(2);
    expect(FRC_I_MIME).toBe("image/x-flora-frc-i");
    expect(FRC_I_EXTENSION).toBe("fri");
  });

  it("normalizes response content types (MIME only; ignores parameters)", () => {
    expect(acceptsFrcI("image/x-flora-frc-i")).toBe(true);
    // Parameter after ';' is ignored — not a wire-version channel.
    expect(acceptsFrcI(" IMAGE/X-FLORA-FRC-I ; charset=binary")).toBe(true);
    expect(acceptsFrcI("image/webp")).toBe(false);
    expect(acceptsFrcI(undefined)).toBe(false);
  });
});
