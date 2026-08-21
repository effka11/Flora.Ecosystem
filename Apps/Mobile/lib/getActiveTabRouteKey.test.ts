import { describe, expect, it } from "vitest";
import {
  getActiveTabRouteKey,
  getActiveTabRouteName,
  getActiveTabSegment,
  isTabActive,
  isTabRoot,
  tabSegmentIndex,
} from "./getActiveTabRouteKey.js";
import { isMessagesInThread } from "./messagesTabBar.js";

describe("getActiveTabRouteKey", () => {
  it("returns active tab key from direct tab state", () => {
    const state = {
      type: "tab",
      index: 1,
      routes: [{ key: "feed-key" }, { key: "music-key" }],
    };
    expect(getActiveTabRouteKey(state)).toBe("music-key");
  });

  it("returns active tab key from nested tab state inside focused stack route", () => {
    const state = {
      type: "stack",
      index: 0,
      routes: [
        {
          key: "tabs-route",
          name: "(tabs)",
          state: {
            type: "tab",
            index: 2,
            routes: [
              { key: "feed-key" },
              { key: "music-key" },
              { key: "messages-key" },
            ],
          },
        },
      ],
    };
    expect(getActiveTabRouteKey(state)).toBe("messages-key");
  });

  it("returns undefined when focused route has no tab state", () => {
    const state = {
      type: "stack",
      index: 1,
      routes: [
        {
          key: "tabs-route",
          state: {
            type: "tab",
            index: 0,
            routes: [{ key: "feed-key" }],
          },
        },
        { key: "compose-key", name: "compose" },
      ],
    };
    expect(getActiveTabRouteKey(state)).toBeUndefined();
  });

  it("returns undefined when no tab state is present", () => {
    expect(getActiveTabRouteKey(undefined)).toBeUndefined();
    expect(getActiveTabRouteKey({ type: "stack", routes: [] })).toBeUndefined();
  });

  it("distinguishes same tab vs different tab keys", () => {
    const state = {
      type: "tab",
      index: 0,
      routes: [{ key: "feed-key" }, { key: "music-key" }],
    };
    const activeKey = getActiveTabRouteKey(state);
    expect(activeKey === "feed-key").toBe(true);
    expect(activeKey === "music-key").toBe(false);
  });
});

describe("getActiveTabRouteName", () => {
  it("returns active tab name from direct tab state", () => {
    const state = {
      type: "tab",
      index: 1,
      routes: [
        { key: "feed-key", name: "feed" },
        { key: "people-key", name: "people" },
      ],
    };
    expect(getActiveTabRouteName(state)).toBe("people");
  });

  it("returns active tab name from nested tab state inside focused stack route", () => {
    const state = {
      type: "stack",
      index: 0,
      routes: [
        {
          key: "tabs-route",
          name: "(tabs)",
          state: {
            type: "tab",
            index: 0,
            routes: [
              { key: "settings-key", name: "settings" },
              { key: "people-key", name: "people" },
            ],
          },
        },
      ],
    };
    expect(getActiveTabRouteName(state)).toBe("settings");
  });
});

describe("tab segments", () => {
  it("resolves active tab segment after (tabs)", () => {
    expect(tabSegmentIndex(["(tabs)", "feed"])).toBe(1);
    expect(getActiveTabSegment(["(tabs)", "messages", "uuid"])).toBe("messages");
  });

  it("isTabActive matches only the active tab slot", () => {
    expect(isTabActive(["(tabs)", "messages"], "messages")).toBe(true);
    expect(isTabActive(["(tabs)", "feed"], "messages")).toBe(false);
  });

  it("isTabRoot is true at tab index without nested routes", () => {
    expect(isTabRoot(["(tabs)", "profile"], "profile")).toBe(true);
    expect(isTabRoot(["(tabs)", "profile", "index"], "profile")).toBe(true);
    expect(isTabRoot(["(tabs)", "profile", "alice"], "profile")).toBe(false);
  });
});

describe("isMessagesInThread", () => {
  it("returns true in conversation route", () => {
    expect(isMessagesInThread(["(tabs)", "messages", "uuid"])).toBe(true);
  });

  it("returns false on messages list root", () => {
    expect(isMessagesInThread(["(tabs)", "messages"])).toBe(false);
    expect(isMessagesInThread(["(tabs)", "messages", "index"])).toBe(false);
  });

  it("returns false when messages is not the active tab", () => {
    expect(isMessagesInThread(["(tabs)", "feed", "messages"])).toBe(false);
  });
});
