import { describe, expect, it } from "vitest";
import {
  acceptsFrcI,
  FRC_I_BITSTREAM_VERSION,
  FRC_I_EXTENSION,
  FRC_I_MIME,
  FRC_I_WASM_ABI_VERSION,
} from "../src/index";

describe("FRC-I integration contracts", () => {
  it("keeps the current v10 MIME contract", () => {
    // Версия отслеживает frc_i::BITSTREAM_VERSION: wasm-артефакт всегда
    // собирается из этого же workspace (Apps/Web predev/prebuild).
    expect(FRC_I_BITSTREAM_VERSION).toBe(10);
    expect(FRC_I_WASM_ABI_VERSION).toBe(2);
    expect(FRC_I_MIME).toBe("image/x-flora-frc-i");
    expect(FRC_I_EXTENSION).toBe("fri");
  });

  it("normalizes response content types", () => {
    expect(acceptsFrcI("image/x-flora-frc-i")).toBe(true);
    expect(acceptsFrcI(" IMAGE/X-FLORA-FRC-I ; version=10")).toBe(true);
    expect(acceptsFrcI("image/webp")).toBe(false);
    expect(acceptsFrcI(undefined)).toBe(false);
  });
});
