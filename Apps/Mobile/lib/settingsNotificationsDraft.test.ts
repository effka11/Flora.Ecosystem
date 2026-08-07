import { describe, expect, it } from "vitest";
import {
  defaultNotificationsDraft,
  maskQuietTimeInput,
  normalizeNotificationsDraft,
  notificationsDraftEqual,
} from "./settingsNotificationsDraft";

describe("settingsNotificationsDraft", () => {
  it("masks quiet time input to HH:MM", () => {
    expect(maskQuietTimeInput("2")).toBe("2");
    expect(maskQuietTimeInput("23")).toBe("23");
    expect(maskQuietTimeInput("230")).toBe("23:0");
    expect(maskQuietTimeInput("2300")).toBe("23:00");
    expect(maskQuietTimeInput("23:00abc")).toBe("23:00");
  });

  it("normalizes partial prefs and keeps event defaults", () => {
    const next = normalizeNotificationsDraft({
      pushEnabled: false,
      quietFrom: "9:00",
      events: {
        likes: { inApp: true, push: false, email: false },
      } as never,
    });
    expect(next.pushEnabled).toBe(false);
    expect(next.quietFrom).toBe("23:00"); // invalid HH:MM → fallback
    expect(next.events.messages.inApp).toBe(true);
    expect(next.events.likes.push).toBe(false);
  });

  it("compares drafts by value", () => {
    const a = defaultNotificationsDraft();
    const b = defaultNotificationsDraft();
    expect(notificationsDraftEqual(a, b)).toBe(true);
    expect(notificationsDraftEqual(a, { ...b, emailEnabled: false })).toBe(false);
  });
});
