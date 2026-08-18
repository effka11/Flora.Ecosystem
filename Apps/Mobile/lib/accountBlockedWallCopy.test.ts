import { describe, expect, it } from "vitest";
import { accountBlockedWallBody } from "./accountBlockedWallCopy";

describe("accountBlockedWallBody", () => {
  it("says permanent only when until is null", () => {
    const body = accountBlockedWallBody(null);
    expect(body).toContain("постоянн");
    expect(body).not.toMatch(/\d/);
  });

  it("includes the end date when until is a parseable string", () => {
    const body = accountBlockedWallBody("2026-12-31T12:00:00.000Z");
    expect(body).toMatch(/31/);
    expect(body).toMatch(/2026/);
    expect(body).not.toContain("постоянн");
  });

  it("claims neither a date nor permanence when until is undefined", () => {
    const body = accountBlockedWallBody(undefined);
    expect(body).not.toContain("постоянн");
    expect(body).not.toMatch(/20\d{2}/);
  });
});
