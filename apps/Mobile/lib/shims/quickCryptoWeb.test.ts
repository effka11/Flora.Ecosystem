import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import QuickCrypto, { install } from "./quickCryptoWeb";

describe("quickCryptoWeb", () => {
  it("matches node sha256 hex for a utf-8 string, including split updates", () => {
    const url = "https://flora.example/posts/фото.jpg?x=1";
    const expected = createHash("sha256").update(url, "utf8").digest("hex");
    expect(QuickCrypto.createHash("sha256").update(url).digest("hex")).toBe(expected);

    const split = QuickCrypto.createHash("sha256").update(url.slice(0, 12)).update(url.slice(12));
    expect(split.digest("hex")).toBe(expected);
  });

  it("install is a no-op and randomBytes uses Web Crypto", () => {
    expect(() => install()).not.toThrow();
    const bytes = QuickCrypto.randomBytes(16);
    expect(bytes).toHaveLength(16);
    expect(bytes.some((byte) => byte !== 0)).toBe(true);
    expect(QuickCrypto.webcrypto.subtle).toBe(globalThis.crypto.subtle);
  });
});
