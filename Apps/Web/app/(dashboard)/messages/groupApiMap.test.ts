import assert from "node:assert/strict";
import test from "node:test";
import {
  findGroupMember,
  mapGroupListItem,
  mergeGroupListRefresh,
} from "./groupApiMap";
import type { GroupChat, GroupMember } from "./groupConversationTypes";

const member = (uuid: string, name: string): GroupMember => ({
  userUuid: uuid,
  username: name,
  displayName: name,
});

test("mergeGroupListRefresh keeps roster from previous detail", () => {
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
      unreadCount: 0,
    }),
  ];
  const merged = mergeGroupListRefresh(prev, next);
  assert.equal(merged[0]!.title, "New");
  assert.equal(merged[0]!.unreadCount, 0);
  assert.equal(merged[0]!.members.length, 2);
  assert.equal(merged[0]!.members[0]!.username, "alice");
});

test("findGroupMember is case-insensitive", () => {
  const members = [member("019e9ee8-E522-7fe5-90bb-8d1084f60366", "me")];
  assert.ok(findGroupMember(members, "019e9ee8-e522-7fe5-90bb-8d1084f60366"));
  assert.equal(findGroupMember(members, ""), undefined);
});
