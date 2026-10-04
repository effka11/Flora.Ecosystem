import { describe, expect, it } from "vitest";
import { decryptAesGcmBlob, encryptAesGcmBlob } from "./aesGcm.js";

describe("AES-GCM media crypto", () => {
  it("roundtrips a blob with WebCrypto", async () => {
    const subtle = globalThis.crypto.subtle;
    const source = new Blob(["voice-payload"], { type: "audio/aac" });
    const enc = await encryptAesGcmBlob(subtle, source, "audio/aac");
    const dec = await decryptAesGcmBlob(subtle, {
      encryptedBlob: enc.encryptedBlob,
      keyBase64Url: enc.keyBase64Url,
      nonceBase64Url: enc.nonceBase64Url,
      contentType: enc.contentType,
    });
    expect(await dec.text()).toBe("voice-payload");
  });
});
