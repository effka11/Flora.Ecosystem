import { afterEach, describe, expect, it } from "vitest";
import {
  __resetChatOpenAvatarWarm,
  CHAT_OPEN_AVATAR_FIRST_FRAME_CACHE,
  chatOpenAvatarPrefetchFillsFirstFrame,
  chatOpenAvatarsNeedPaint,
  chatOpenAvatarsReadyNow,
  clearChatOpenAvatarPaint,
  collectChatOpenAvatarUuids,
  noteChatOpenAvatarDecoded,
  noteChatOpenAvatarPainted,
  noteChatOpenAvatarPrefetched,
  warmChatOpenAvatarBitmaps,
  whenChatOpenAvatarsFirstFrame,
  whenChatOpenAvatarsPainted,
  type ChatAvatarWarmDeps,
} from "@/lib/chatOpenAvatars";

afterEach(() => {
  __resetChatOpenAvatarWarm();
});

describe("chatOpenAvatarsReadyNow", () => {
  const indexed = new Set(["peer", "other"]);
  const peek = (uuid: string) => (indexed.has(uuid) ? `file:///${uuid}.png` : "");

  it("is not ready on a file peek without paint or a first-frame prefetch", () => {
    expect(chatOpenAvatarsReadyNow(["peer", "other"], peek)).toBe(false);
    expect(chatOpenAvatarsReadyNow(["peer", "missing"], peek)).toBe(false);
    expect(chatOpenAvatarsReadyNow([], peek)).toBe(true);
    expect(chatOpenAvatarsReadyNow([" ", ""], peek)).toBe(true);
  });

  it("is ready after the thread circle paints", () => {
    expect(chatOpenAvatarsReadyNow(["peer"], peek)).toBe(false);
    noteChatOpenAvatarPainted("peer");
    expect(chatOpenAvatarsReadyNow(["peer"], peek)).toBe(true);
  });

  it("is not ready while a cold decode of this park has not painted", () => {
    noteChatOpenAvatarDecoded("peer");
    expect(chatOpenAvatarsReadyNow(["peer"], peek)).toBe(false);
    noteChatOpenAvatarPainted("peer");
    expect(chatOpenAvatarsReadyNow(["peer"], peek)).toBe(true);
  });

  it("counts a prefetch only when it fills the cache the first frame reads", () => {
    expect(chatOpenAvatarPrefetchFillsFirstFrame(CHAT_OPEN_AVATAR_FIRST_FRAME_CACHE)).toBe(true);
    expect(CHAT_OPEN_AVATAR_FIRST_FRAME_CACHE).toBe("memory");
    expect(chatOpenAvatarPrefetchFillsFirstFrame("memory-disk")).toBe(false);
    expect(chatOpenAvatarPrefetchFillsFirstFrame("disk")).toBe(false);

    noteChatOpenAvatarPrefetched("peer", "memory-disk");
    expect(chatOpenAvatarsReadyNow(["peer"], peek)).toBe(false);
    noteChatOpenAvatarPrefetched("peer", "disk");
    expect(chatOpenAvatarsReadyNow(["peer"], peek)).toBe(false);
    noteChatOpenAvatarPrefetched("peer", CHAT_OPEN_AVATAR_FIRST_FRAME_CACHE);
    expect(chatOpenAvatarsReadyNow(["peer"], peek)).toBe(true);
  });
});

describe("whenChatOpenAvatarsFirstFrame", () => {
  const peek = (uuid: string) => `file:///${uuid}.png`;

  function timers() {
    const queue: { run: () => void; ms: number; cancelled: boolean }[] = [];
    return {
      queue,
      schedule: (run: () => void, ms: number) => {
        const entry = { run, ms, cancelled: false };
        queue.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    };
  }

  it("resolves ready when the circle is already painted", async () => {
    const t = timers();
    noteChatOpenAvatarPainted("peer");
    await expect(
      whenChatOpenAvatarsFirstFrame(["peer"], peek, { timeoutMs: 200, schedule: t.schedule }),
    ).resolves.toBe("ready");
    expect(t.queue).toEqual([]);
  });

  it("resolves ready when prefetch hits the first-frame cache", async () => {
    const t = timers();
    const wait = whenChatOpenAvatarsFirstFrame(["peer"], peek, {
      timeoutMs: 200,
      schedule: t.schedule,
    });
    noteChatOpenAvatarPrefetched("peer", "memory-disk");
    await Promise.resolve();
    expect(t.queue[0]?.cancelled).toBe(false);
    noteChatOpenAvatarPrefetched("peer", CHAT_OPEN_AVATAR_FIRST_FRAME_CACHE);
    await expect(wait).resolves.toBe("ready");
    expect(t.queue[0]?.cancelled).toBe(true);
  });

  it("resolves capped at the ceiling and that open is not ready", async () => {
    const t = timers();
    const wait = whenChatOpenAvatarsFirstFrame(["peer"], peek, {
      timeoutMs: 200,
      schedule: t.schedule,
    });
    expect(t.queue[0]?.ms).toBe(200);
    t.queue[0]!.run();
    await expect(wait).resolves.toBe("capped");
    expect(chatOpenAvatarsReadyNow(["peer"], peek)).toBe(false);
  });
});

describe("whenChatOpenAvatarsPainted", () => {
  function timers() {
    const queue: { run: () => void; ms: number; cancelled: boolean }[] = [];
    return {
      queue,
      schedule: (run: () => void, ms: number) => {
        const entry = { run, ms, cancelled: false };
        queue.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    };
  }

  it("resolves at once when nothing waits for paint", async () => {
    const t = timers();
    await expect(
      whenChatOpenAvatarsPainted(["peer"], { timeoutMs: 200, schedule: t.schedule }),
    ).resolves.toBeUndefined();
    expect(t.queue).toEqual([]);
  });

  it("resolves on the onLoad of the last cold circle and drops the cap", async () => {
    const t = timers();
    noteChatOpenAvatarDecoded("a");
    noteChatOpenAvatarDecoded("b");
    let settled = false;
    const wait = whenChatOpenAvatarsPainted(["a", "b"], {
      timeoutMs: 200,
      schedule: t.schedule,
    }).then(() => {
      settled = true;
    });
    noteChatOpenAvatarPainted("a");
    await Promise.resolve();
    expect(settled).toBe(false);
    noteChatOpenAvatarPainted("b");
    await wait;
    expect(settled).toBe(true);
    expect(t.queue[0]?.cancelled).toBe(true);
  });

  it("resolves by the cap when a circle never paints", async () => {
    const t = timers();
    noteChatOpenAvatarDecoded("a");
    const wait = whenChatOpenAvatarsPainted(["a"], { timeoutMs: 200, schedule: t.schedule });
    expect(t.queue[0]?.ms).toBe(200);
    t.queue[0]!.run();
    await expect(wait).resolves.toBeUndefined();
    // Отметка холодного декода остаётся: следующий парк снова ждёт bitmap.
    expect(chatOpenAvatarsNeedPaint(["a"])).toBe(true);
  });
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
