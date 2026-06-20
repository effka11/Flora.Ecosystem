import { describe, expect, it } from "vitest";
import { toBase64Url, fromBase64Url } from "./unlockFlow.js";
import { FSCP_BOOTSTRAP_KEY_EPOCH_ID } from "./constants.js";

describe("fscp cross-fixtures", () => {
  it("roundtrips base64url helpers", () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 255]);
    const encoded = toBase64Url(bytes);
    expect(encoded).not.toContain("+");
    expect(fromBase64Url(encoded)).toEqual(bytes);
  });

  it("keeps bootstrap epoch id stable", () => {
    expect(FSCP_BOOTSTRAP_KEY_EPOCH_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
