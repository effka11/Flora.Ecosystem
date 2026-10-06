import { describe, expect, it } from "vitest";
import {
  BACKGROUND_DECRYPT_TAIL,
  backgroundDecryptWindowUnits,
  messagesForBackgroundDecrypt,
  noteBackgroundDecryptWindow,
  resetBackgroundDecryptWindowUnits,
} from "@/lib/backgroundDecryptWindow";

describe("messagesForBackgroundDecrypt", () => {
  it("keeps the full page for ranks 1-4 and the tail afterwards", () => {
    resetBackgroundDecryptWindowUnits();
    const page = Array.from({ length: 50 }, (_, index) => index);
    expect(messagesForBackgroundDecrypt(page, 1)).toBe(page);
    expect(messagesForBackgroundDecrypt(page, 4)).toHaveLength(50);
    expect(messagesForBackgroundDecrypt(page, 5)).toEqual(page.slice(-BACKGROUND_DECRYPT_TAIL));
    expect(messagesForBackgroundDecrypt(page.slice(0, 10), 9)).toHaveLength(10);

    let units = 0;
    for (let rank = 1; rank <= 18; rank += 1) {
      const window = messagesForBackgroundDecrypt(page, rank);
      noteBackgroundDecryptWindow(window.length);
      units += window.length;
    }
    expect(units).toBe(4 * 50 + 14 * 24);
    expect(backgroundDecryptWindowUnits()).toBe(4 * 50 + 14 * 24);
    resetBackgroundDecryptWindowUnits();
    expect(backgroundDecryptWindowUnits()).toBe(0);
  });
});
