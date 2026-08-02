import { describe, expect, it } from "vitest";
import {
  countArchivedPeers,
  filterConversationsByFolder,
  listVisibleChatFolders,
  normalizeChatListFolder,
  pruneArchivedPeers,
  setPeerArchivedFlag,
} from "./chatListFolders.js";

describe("chatListFolders", () => {
  it("shows archive folder only when there is at least one archived peer", () => {
    expect(listVisibleChatFolders(0)).toEqual([]);
    expect(listVisibleChatFolders(1).map((f) => f.id)).toEqual(["archived"]);
  });

  it("falls back to all when archive folder becomes empty", () => {
    expect(normalizeChatListFolder("archived", 0)).toBe("all");
    expect(normalizeChatListFolder("archived", 2)).toBe("archived");
    expect(normalizeChatListFolder("all", 0)).toBe("all");
  });

  it("filters by folder", () => {
    const items = [
      { otherUserUuid: "a" },
      { otherUserUuid: "b" },
      { otherUserUuid: "c" },
    ];
    const archived = { a: true as const, c: true as const };
    expect(filterConversationsByFolder(items, "all", archived).map((i) => i.otherUserUuid)).toEqual([
      "b",
    ]);
    expect(
      filterConversationsByFolder(items, "archived", archived).map((i) => i.otherUserUuid),
    ).toEqual(["a", "c"]);
  });

  it("prunes deleted peers and counts only known ones", () => {
    const archived = { a: true as const, gone: true as const };
    const known = new Set(["a", "b"]);
    expect(countArchivedPeers(archived, known)).toBe(1);
    expect(pruneArchivedPeers(archived, known)).toEqual({ a: true });
  });

  it("toggles archive flag immutably", () => {
    const empty = {};
    const withA = setPeerArchivedFlag(empty, "a", true);
    expect(withA).toEqual({ a: true });
    expect(setPeerArchivedFlag(withA, "a", true)).toBe(withA);
    expect(setPeerArchivedFlag(withA, "a", false)).toEqual({});
  });
});
