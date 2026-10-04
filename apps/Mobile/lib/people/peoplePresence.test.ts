import { describe, expect, it } from "vitest";
import { peoplePresenceShouldRegister } from "./peoplePresence";

describe("peoplePresenceShouldRegister", () => {
  it("registers when the tab is focused", () => {
    expect(peoplePresenceShouldRegister(true)).toBe(true);
  });

  it("does not register when the tab is unfocused", () => {
    expect(peoplePresenceShouldRegister(false)).toBe(false);
  });
});
