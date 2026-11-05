import { describe, expect, it } from "vitest";
import { createKeyedLiveValue } from "./liveCache";

describe("createKeyedLiveValue", () => {
  it("returns the same value for the same key and rebuilds on key change", () => {
    let key = "dark";
    let builds = 0;
    const value = createKeyedLiveValue(() => ({ build: ++builds }), () => key);
    expect(value.build).toBe(1);
    expect(value.build).toBe(1);
    key = "light";
    expect(value.build).toBe(2);
    key = "dark";
    expect(value.build).toBe(1);
  });

  it("evicts the oldest entry beyond the limit", () => {
    let key = "a";
    let builds = 0;
    const value = createKeyedLiveValue(() => ({ build: ++builds }), () => key, 2);
    expect(value.build).toBe(1);
    key = "b";
    expect(value.build).toBe(2);
    key = "c";
    expect(value.build).toBe(3);
    key = "a";
    expect(value.build).toBe(4);
  });

  it("keeps the dev-freeze behavior of StyleSheet proxies", () => {
    const value = createKeyedLiveValue(() => ({ token: "x" }), () => "same");
    expect(() => Object.freeze(value)).toThrow(TypeError);
    expect(value.token).toBe("x");
  });
});
