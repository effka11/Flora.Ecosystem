import { describe, expect, it } from "vitest";
import { isSocialTrayPushData } from "./socialPushTags.js";

describe("socialPushTags", () => {
  it("recognizes like/follow tray tags and inboxType", () => {
    expect(
      isSocialTrayPushData({
        type: "notification",
        tag: "like:01900000-0000-7000-8000-000000000001",
      }),
    ).toBe(true);
    expect(isSocialTrayPushData({ type: "notification_dismiss", tag: "follow" })).toBe(true);
    expect(isSocialTrayPushData({ type: "notification", inboxType: "like" })).toBe(true);
    expect(isSocialTrayPushData({ type: "message", tag: "follow" })).toBe(false);
    expect(isSocialTrayPushData({ type: "notification", tag: "other" })).toBe(false);
  });
});
