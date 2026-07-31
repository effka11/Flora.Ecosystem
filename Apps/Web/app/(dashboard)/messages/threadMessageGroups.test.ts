import assert from "node:assert/strict";
import test from "node:test";
import type { MessageThreadItemDto } from "@/lib/socialApi";
import { buildThreadRenderItems } from "./threadMessageGroups";

function msg(partial: Partial<MessageThreadItemDto> & { messageUuid: string; isFromMe: boolean }): MessageThreadItemDto {
  return {
    content: null,
    encryptedForMe: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

test("decrypting hole at start of peer run keeps groupKey of first raw uuid", () => {
  const a = msg({ messageUuid: "a", isFromMe: false });
  const b = msg({ messageUuid: "b", isFromMe: false });
  const hidden = new Set(["a"]);
  const items = buildThreadRenderItems([a, b], (m) => !hidden.has(m.messageUuid));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "peerGroup");
  if (items[0]!.kind !== "peerGroup") return;
  assert.equal(items[0].groupKey, "a");
  assert.deepEqual(
    items[0].messages.map((m) => m.messageUuid),
    ["b"],
  );
});

test("decrypting hole in middle of peer run keeps same groupKey", () => {
  const a = msg({ messageUuid: "a", isFromMe: false });
  const b = msg({ messageUuid: "b", isFromMe: false });
  const c = msg({ messageUuid: "c", isFromMe: false });
  const hidden = new Set(["b"]);
  const items = buildThreadRenderItems([a, b, c], (m) => !hidden.has(m.messageUuid));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "peerGroup");
  if (items[0]!.kind !== "peerGroup") return;
  assert.equal(items[0].groupKey, "a");
  assert.deepEqual(
    items[0].messages.map((m) => m.messageUuid),
    ["a", "c"],
  );
});

test("own message breaks peer groups", () => {
  const a = msg({ messageUuid: "a", isFromMe: false });
  const me = msg({ messageUuid: "me", isFromMe: true });
  const b = msg({ messageUuid: "b", isFromMe: false });
  const items = buildThreadRenderItems([a, me, b], () => true);
  assert.equal(items.length, 3);
  assert.equal(items[0]!.kind, "peerGroup");
  assert.equal(items[1]!.kind, "own");
  assert.equal(items[2]!.kind, "peerGroup");
  if (items[0]!.kind === "peerGroup") assert.equal(items[0].groupKey, "a");
  if (items[2]!.kind === "peerGroup") assert.equal(items[2].groupKey, "b");
});

test("peer run with all hidden is omitted", () => {
  const a = msg({ messageUuid: "a", isFromMe: false });
  const b = msg({ messageUuid: "b", isFromMe: false });
  const items = buildThreadRenderItems([a, b], () => false);
  assert.deepEqual(items, []);
});

test("revealing first raw message does not change groupKey", () => {
  const a = msg({ messageUuid: "a", isFromMe: false });
  const b = msg({ messageUuid: "b", isFromMe: false });
  const before = buildThreadRenderItems([a, b], (m) => m.messageUuid !== "a");
  const after = buildThreadRenderItems([a, b], () => true);
  assert.equal(before[0]!.kind, "peerGroup");
  assert.equal(after[0]!.kind, "peerGroup");
  if (before[0]!.kind !== "peerGroup" || after[0]!.kind !== "peerGroup") return;
  assert.equal(before[0].groupKey, after[0].groupKey);
  assert.equal(after[0].groupKey, "a");
});
