import { describe, expect, it } from "vitest";
import {
  addPeerToChatListEntity,
  canArchiveChatListPeer,
  canCreateChatListFolder,
  chatListFolderPageIds,
  chatListFolderPageIndex,
  chatListOverlayFromApi,
  countArchivedForFolderIcon,
  countArchivedPeers,
  createChatListFolderEntity,
  createChatListGroupEntity,
  entitiesToFolderDefs,
  filterConversationsByFolder,
  filterGroupsByFolder,
  listVisibleChatFolders,
  maxCustomChatListFolders,
  membershipByEntityId,
  normalizeChatListFolder,
  orderChatListFolders,
  parseChatListOverlayState,
  pruneArchivedPeers,
  removeChatListEntity,
  setPeerArchivedFlag,
} from "./chatListFolders.js";

describe("chatListFolders", () => {
  it("shows archive folder only when there is at least one archived peer", () => {
    expect(listVisibleChatFolders(0)).toEqual([]);
    expect(listVisibleChatFolders(1).map((f) => f.id)).toEqual(["archived"]);
  });

  it("keeps custom folders left of archive (archive always last before +)", () => {
    const custom = [
      { id: "work", label: "Работа" },
      { id: "friends", label: "Друзья" },
    ];
    expect(listVisibleChatFolders(0, custom).map((f) => f.id)).toEqual(["work", "friends"]);
    expect(listVisibleChatFolders(2, custom).map((f) => f.id)).toEqual([
      "work",
      "friends",
      "archived",
    ]);
    expect(
      orderChatListFolders([
        { id: "archived", label: "Архив" },
        { id: "work", label: "Работа" },
      ]).map((f) => f.id),
    ).toEqual(["work", "archived"]);
  });

  it("orders pager pages with all as the leftmost page", () => {
    const visible = listVisibleChatFolders(1, [
      { id: "work", label: "Работа" },
      { id: "friends", label: "Друзья" },
    ]);
    const pages = chatListFolderPageIds(visible);
    expect(pages).toEqual(["all", "work", "friends", "archived"]);
    expect(chatListFolderPageIndex(pages, "all")).toBe(0);
    expect(chatListFolderPageIndex(pages, "archived")).toBe(3);
    expect(chatListFolderPageIndex(pages, "missing")).toBe(0);
  });

  it("caps folder icons at 4 including archive", () => {
    const custom = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: "d", label: "D" },
      { id: "e", label: "E" },
    ];
    expect(listVisibleChatFolders(0, custom).map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
    expect(listVisibleChatFolders(1, custom).map((f) => f.id)).toEqual([
      "a",
      "b",
      "c",
      "archived",
    ]);
    expect(maxCustomChatListFolders(0)).toBe(4);
    expect(maxCustomChatListFolders(2)).toBe(3);
    expect(canCreateChatListFolder(0, 3)).toBe(true);
    expect(canCreateChatListFolder(0, 4)).toBe(false);
    expect(canCreateChatListFolder(1, 3)).toBe(false);
    expect(canArchiveChatListPeer(0, 3)).toBe(true);
    expect(canArchiveChatListPeer(0, 4)).toBe(false);
    expect(canArchiveChatListPeer(1, 4)).toBe(true);
  });

  it("falls back to all when archive folder becomes empty", () => {
    expect(normalizeChatListFolder("archived", 0)).toBe("all");
    expect(normalizeChatListFolder("archived", 2)).toBe("archived");
    expect(normalizeChatListFolder("all", 0)).toBe("all");
    expect(normalizeChatListFolder("fld_x", 1, new Set(["fld_y"]))).toBe("all");
    expect(normalizeChatListFolder("fld_x", 1, new Set(["fld_x"]))).toBe("fld_x");
  });

  it("countArchivedForFolderIcon avoids DM double-count", () => {
    // Heuristic without DM set: peer + max(0, conv−peer).
    expect(countArchivedForFolderIcon({ a: true }, { dmA: true })).toBe(1);
    expect(countArchivedForFolderIcon({ a: true }, { dmA: true, group1: true })).toBe(2);
    expect(countArchivedForFolderIcon({}, { group1: true, group2: true })).toBe(2);

    // Exact set: peer archived without conv side-write + group still counts 2.
    const dmSet = new Set(["dmA"]);
    expect(
      countArchivedForFolderIcon({ a: true }, { group1: true }, dmSet),
    ).toBe(2);
    expect(
      countArchivedForFolderIcon({ a: true }, { dmA: true, group1: true }, dmSet),
    ).toBe(2);

    const groups = [{ conversationUuid: "g1" }, { conversationUuid: "g2" }];
    expect(
      filterGroupsByFolder(groups, "all", { g1: true }).map((g) => g.conversationUuid),
    ).toEqual(["g2"]);
    expect(
      filterGroupsByFolder(groups, "archived", { g1: true }).map((g) => g.conversationUuid),
    ).toEqual(["g1"]);
  });

  it("filters by folder and custom membership", () => {
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

    const membership = { work: ["b", "c"] };
    expect(
      filterConversationsByFolder(items, "work", {}, membership).map((i) => i.otherUserUuid),
    ).toEqual(["b", "c"]);
    expect(
      filterConversationsByFolder(items, "work", archived, membership).map((i) => i.otherUserUuid),
    ).toEqual(["b"]);
  });

  it("creates folder/group entities and maps them to UI defs", () => {
    const folder = createChatListFolderEntity({
      icon: "heart-outline",
      memberPeerUuids: ["u1", "u1", "u2"],
      nowMs: 1,
    });
    expect(folder.kind).toBe("folder");
    expect(folder.memberPeerUuids).toEqual(["u1", "u2"]);
    expect(folder.icon).toBe("heart-outline");

    const group = createChatListGroupEntity({
      name: "  Команда  ",
      avatarUri: "file://a.jpg",
      memberPeerUuids: ["u3"],
      nowMs: 2,
    });
    expect(group.kind).toBe("group");
    expect(group.label).toBe("Команда");
    expect(group.avatarUri).toBe("file://a.jpg");

    expect(entitiesToFolderDefs([folder, group]).map((d) => d.kind)).toEqual(["folder", "group"]);
    expect(membershipByEntityId([folder, group])[folder.id]).toEqual(["u1", "u2"]);
  });

  it("adds peer to entity, removes entity, and parses overlay state", () => {
    const folder = createChatListFolderEntity({
      icon: "folder-outline",
      memberPeerUuids: ["u1"],
      nowMs: 1,
    });
    const next = addPeerToChatListEntity([folder], folder.id, "u2");
    expect(next[0]?.memberPeerUuids).toEqual(["u1", "u2"]);
    expect(addPeerToChatListEntity(next, folder.id, "u2")).toBe(next);
    expect(removeChatListEntity(next, folder.id)).toEqual([]);
    expect(removeChatListEntity(next, "missing")).toBe(next);

    const parsed = parseChatListOverlayState({
      v: 1,
      entities: next,
      archivedByPeer: { u1: true },
      mutedByPeer: {},
    });
    expect(parsed?.entities).toHaveLength(1);
    expect(parsed?.archivedByPeer).toEqual({ u1: true });
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

  it("maps server overlay DTO into local state", () => {
    const mapped = chatListOverlayFromApi({
      entities: [
        {
          id: "0193abcd-0000-7000-8000-000000000001",
          kind: "folder",
          label: "Работа",
          icon: "briefcase-outline",
          memberPeerUuids: ["u1", "u2"],
          createdAt: "2026-08-02T10:00:00.000Z",
        },
      ],
      archivedPeerUuids: ["u3"],
      mutedPeerUuids: ["u1"],
    });
    expect(mapped?.entities).toHaveLength(1);
    expect(mapped?.entities[0]?.id).toBe("0193abcd-0000-7000-8000-000000000001");
    expect(mapped?.entities[0]?.createdAtMs).toBe(Date.parse("2026-08-02T10:00:00.000Z"));
    expect(mapped?.archivedByPeer).toEqual({ u3: true });
    expect(mapped?.mutedByPeer).toEqual({ u1: true });
  });
});
