import assert from "node:assert/strict";
import test from "node:test";

import type { FscpMessagePlaintext } from "@/lib/fscp";

import { dropDecryptedIds } from "./optimisticDecrypt";

const sample = (body: string): FscpMessagePlaintext => ({
  type: "blocks",
  version: 1,
  blocks: [{ kind: "text", body }],
  clientCreatedAt: "2026-01-01T00:00:00.000Z",
});

test("dropDecryptedIds removes only listed ids", () => {
  const prev = {
    a: sample("A"),
    b: sample("B"),
    c: sample("C"),
  };
  const next = dropDecryptedIds(prev, ["a", "c"]);
  assert.deepEqual(Object.keys(next).sort(), ["b"]);
  assert.equal(next.b, prev.b);
});

test("dropDecryptedIds ignores null and undefined ids", () => {
  const prev = { a: sample("A") };
  const next = dropDecryptedIds(prev, [null, undefined, ""]);
  assert.deepEqual(next, prev);
});

test("dropDecryptedIds does not mutate prev", () => {
  const prev = { a: sample("A"), b: sample("B") };
  const snapshot = { ...prev };
  dropDecryptedIds(prev, ["a"]);
  assert.deepEqual(prev, snapshot);
});
