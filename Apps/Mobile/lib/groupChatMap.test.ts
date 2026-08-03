import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  findGroupMember,
  groupApiMessagesToThread,
  groupRosterNeedsRefresh,
  mapGroupListItem,
  mergeGroupListRefresh,
} from "./groupChatMap";
import type { GroupChat, GroupMember } from "./groupChatTypes";

const member = (uuid: string, name: string): GroupMember => ({
  userUuid: uuid,
  username: name,
  displayName: name,
});

describe("mergeGroupListRefresh", () => {
  it("keeps roster when memberCount matches", () => {
    const prev: GroupChat[] = [
      {
        ...mapGroupListItem({
          conversationUuid: "AAAA",
          title: "Old",
          createdByUserUuid: "c1",
          createdAt: "t0",
          memberCount: 2,
          lastMessageEncryptedWire: null,
          lastMessageAt: null,
          lastMessageIsFromMe: false,
          lastMessageSenderDisplayName: "Алиса",
          unreadCount: 1,
        }),
        members: [member("U1", "alice"), member("U2", "bob")],
        memberCount: 2,
      },
    ];
    const next = [
      mapGroupListItem({
        conversationUuid: "aaaa",
        title: "New",
        createdByUserUuid: "c1",
        createdAt: "t0",
        memberCount: 2,
        lastMessageEncryptedWire: "fscpg1:x",
        lastMessageAt: "t1",
        lastMessageIsFromMe: true,
        lastMessageSenderDisplayName: null,
        unreadCount: 0,
      }),
    ];
    const merged = mergeGroupListRefresh(prev, next);
    assert.equal(merged[0]!.title, "New");
    assert.equal(merged[0]!.members.length, 2);
    assert.equal(merged[0]!.members[0]!.username, "alice");
    assert.equal(merged[0]!.lastMessageIsFromMe, true);
    assert.equal(merged[0]!.lastMessageSenderDisplayName, null);
  });

  it("drops roster when memberCount diverges", () => {
    const prev: GroupChat[] = [
      {
        ...mapGroupListItem({
          conversationUuid: "AAAA",
          title: "Old",
          createdByUserUuid: "c1",
          createdAt: "t0",
          memberCount: 3,
          lastMessageEncryptedWire: null,
          lastMessageAt: null,
          lastMessageIsFromMe: false,
          lastMessageSenderDisplayName: null,
          unreadCount: 0,
        }),
        members: [member("U1", "a"), member("U2", "b"), member("U3", "c")],
        memberCount: 3,
      },
    ];
    const next = [
      mapGroupListItem({
        conversationUuid: "aaaa",
        title: "Old",
        createdByUserUuid: "c1",
        createdAt: "t0",
        memberCount: 2,
        lastMessageEncryptedWire: null,
        lastMessageAt: null,
        lastMessageIsFromMe: false,
        lastMessageSenderDisplayName: null,
        unreadCount: 0,
      }),
    ];
    const merged = mergeGroupListRefresh(prev, next);
    assert.equal(merged[0]!.members.length, 0);
    assert.equal(merged[0]!.memberCount, 2);
  });
});

describe("findGroupMember / rosterNeedsRefresh / adapter", () => {
  it("finds member case-insensitively", () => {
    const members = [member("019e9ee8-E522-7fe5-90bb-8d1084f60366", "me")];
    assert.ok(findGroupMember(members, "019e9ee8-e522-7fe5-90bb-8d1084f60366"));
  });

  it("flags roster refresh on count mismatch", () => {
    const g: GroupChat = {
      ...mapGroupListItem({
        conversationUuid: "g",
        title: "G",
        createdByUserUuid: "c",
        createdAt: "t",
        memberCount: 3,
        lastMessageEncryptedWire: null,
        lastMessageAt: null,
        lastMessageIsFromMe: false,
        lastMessageSenderDisplayName: null,
        unreadCount: 0,
      }),
      members: [member("a", "a"), member("b", "b")],
      memberCount: 3,
    };
    assert.equal(groupRosterNeedsRefresh(g), true);
  });

  it("maps group messages to thread DTOs", () => {
    const rows = groupApiMessagesToThread("conv", [
      {
        messageUuid: "m1",
        senderUserUuid: "s1",
        encryptedWire: "fscpg1:abc",
        createdAt: "t",
        isFromMe: false,
      },
    ]);
    assert.equal(rows[0]!.encryptedPayload, "fscpg1:abc");
    assert.equal(rows[0]!.senderUserUuid, "s1");
    assert.equal(rows[0]!.conversationUuid, "conv");
  });
});
