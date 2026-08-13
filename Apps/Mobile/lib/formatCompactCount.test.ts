import { describe, expect, it } from "vitest";
import { formatCompactCount } from "@/lib/formatCompactCount";

describe("formatCompactCount", () => {
  it("keeps values under a thousand as digits", () => {
    expect(formatCompactCount(0)).toBe("0");
    expect(formatCompactCount(1)).toBe("1");
    expect(formatCompactCount(999)).toBe("999");
  });

  it("floors thousands without a decimal", () => {
    expect(formatCompactCount(1000)).toBe("1к");
    expect(formatCompactCount(1842)).toBe("1к");
    expect(formatCompactCount(2000)).toBe("2к");
    expect(formatCompactCount(3921)).toBe("3к");
    expect(formatCompactCount(9999)).toBe("9к");
    expect(formatCompactCount(12_847)).toBe("12к");
    expect(formatCompactCount(128_493)).toBe("128к");
  });

  it("floors millions without a decimal", () => {
    expect(formatCompactCount(1_000_000)).toBe("1м");
    expect(formatCompactCount(1_250_000)).toBe("1м");
    expect(formatCompactCount(12_000_000)).toBe("12м");
  });

  it("floors non-integers and treats junk as 0", () => {
    expect(formatCompactCount(3.9)).toBe("3");
    expect(formatCompactCount(-12)).toBe("0");
    expect(formatCompactCount(Number.NaN)).toBe("0");
  });
});
