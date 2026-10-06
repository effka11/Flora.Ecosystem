import { afterEach, describe, expect, it } from "vitest";
import {
  __resetChatOpenAvatarWarm,
  chatOpenAvatarsNeedPaint,
  clearChatOpenAvatarPaint,
  collectChatOpenAvatarUuids,
  noteChatOpenAvatarDecoded,
  noteChatOpenAvatarPainted,
  warmChatOpenAvatarBitmaps,
  type ChatAvatarWarmDeps,
} from "@/lib/chatOpenAvatars";

afterEach(() => {
  __resetChatOpenAvatarWarm();
});

describe("chatOpenAvatarsNeedPaint", () => {
  it("waits only for a cold decode that has not painted", () => {
    expect(chatOpenAvatarsNeedPaint(["peer"])).toBe(false);
    noteChatOpenAvatarDecoded("peer");
    expect(chatOpenAvatarsNeedPaint(["peer"])).toBe(true);
    noteChatOpenAvatarPainted("peer");
    expect(chatOpenAvatarsNeedPaint(["peer"])).toBe(false);
  });

  it("a later decode note does not revive a circle that already painted", () => {
    noteChatOpenAvatarPainted("peer");
    noteChatOpenAvatarDecoded("peer");
    expect(chatOpenAvatarsNeedPaint(["peer"])).toBe(false);
  });

  it("clear drops both marks", () => {
    noteChatOpenAvatarDecoded("peer");
    clearChatOpenAvatarPaint();
    expect(chatOpenAvatarsNeedPaint(["peer"])).toBe(false);
  });
});

describe("collectChatOpenAvatarUuids", () => {
  it("keeps the header and drops empty duplicates", () => {
    expect(
      collectChatOpenAvatarUuids("peer", [
        { avatarUuid: "peer" },
        { avatarUuid: "  " },
        { avatarUuid: null },
        { avatarUuid: "other" },
      ]),
    ).toEqual(["peer", "other"]);
  });
});

describe("warmChatOpenAvatarBitmaps", () => {
  it("prefetches once when two callers share an in-flight decode", async () => {
    let resolveReady: (uri: string) => void = () => {};
    let readyCalls = 0;
    const prefetched: string[][] = [];
    const deps: ChatAvatarWarmDeps = {
      displayWidth: 45,
      ready: () => {
        readyCalls += 1;
        return new Promise((resolve) => {
          resolveReady = (uri) => resolve({ pace: "decoded", uri });
        });
      },
      prefetch: async (uris) => {
        prefetched.push([...uris]);
      },
    };
    const first = warmChatOpenAvatarBitmaps(["a"], deps);
    const second = warmChatOpenAvatarBitmaps(["a"], deps);
    expect(readyCalls).toBe(1);
    resolveReady("file:///a.png");
    await expect(first).resolves.toBe("decoded");
    await expect(second).resolves.toBe("decoded");
    expect(prefetched).toEqual([["file:///a.png"], ["file:///a.png"]]);
  });

  it("reports cached when every avatar was already decoded", async () => {
    let prefetches = 0;
    const deps: ChatAvatarWarmDeps = {
      displayWidth: 45,
      ready: async () => ({ pace: "cached", uri: "file:///a.png" }),
      prefetch: async () => {
        prefetches += 1;
      },
    };
    await expect(warmChatOpenAvatarBitmaps(["a", "a"], deps)).resolves.toBe("cached");
    await expect(warmChatOpenAvatarBitmaps(["a"], deps)).resolves.toBe("cached");
    expect(prefetches).toBe(0);
  });

  it("does not prefetch when there is no avatar", async () => {
    let prefetches = 0;
    const deps: ChatAvatarWarmDeps = {
      displayWidth: 45,
      ready: async () => {
        throw new Error("unused");
      },
      prefetch: async () => {
        prefetches += 1;
      },
    };
    await expect(warmChatOpenAvatarBitmaps(["", null], deps)).resolves.toBe("cached");
    expect(prefetches).toBe(0);
  });
});
