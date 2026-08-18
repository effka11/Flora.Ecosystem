import assert from "node:assert/strict";
import test from "node:test";
import { ApiRequestError } from "@flora/client-core/api";
import type {
  FrankingAuditDto,
  FrankingQueueDto,
  FrankingReportMetaDto,
} from "@flora/client-core/contracts";
import {
  ALLOWED_FRANKING_API_CALLS,
  appendQueuePage,
  assertAllowedFrankingCalls,
  createRecordingFrankingDeps,
  dispatchClaimReport,
  dispatchResolveReport,
  filterQueueItems,
  loadInitialQueue,
  mergeReportIntoQueue,
  canCloseAsClaimer,
  canReleaseAsClaimer,
  canResolveReport,
} from "./moderationQueue";

const NOT_REVIEWER = "Нужна роль franking-ревьюера.";
const ROSTER_UNAVAILABLE = "Список franking-ревьюеров не загружен.";
const ALREADY_CLAIMED = "Заявка уже занята.";

const REPORT_A: FrankingReportMetaDto = {
  reportUuid: "11111111-1111-1111-1111-111111111111",
  persistedMessageUuid: "22222222-2222-2222-2222-222222222222",
  conversationUuid: "33333333-3333-3333-3333-333333333333",
  category: "abuse",
  status: "open",
  claimedBy: null,
  claimedAt: null,
  createdAt: "2026-08-17T12:00:00.000Z",
  viewerAccountCount: 1,
  hasDisclosure: true,
  verificationStatus: "verifiable",
  reporterUsername: "alice",
  accusedUsername: "bob",
};

const REPORT_B: FrankingReportMetaDto = {
  ...REPORT_A,
  reportUuid: "44444444-4444-4444-4444-444444444444",
  createdAt: "2026-08-17T11:00:00.000Z",
};

function page(items: FrankingReportMetaDto[], nextCursor: string | null, hasMore: boolean): FrankingQueueDto {
  return { items, nextCursor, hasMore };
}

test("appendQueuePage loads the second page via nextCursor and stops when hasMore is false", async () => {
  let queueCalls = 0;
  const { deps } = createRecordingFrankingDeps({
    getQueue: async (cursor) => {
      queueCalls += 1;
      if (!cursor) {
        return page([REPORT_A], "cursor-page-2", true);
      }
      assert.equal(cursor, "cursor-page-2");
      return page([REPORT_B], null, false);
    },
  });

  const initial = await loadInitialQueue(deps);
  assert.equal(initial.kind, "ok");
  if (initial.kind !== "ok") return;
  assert.deepEqual(initial.queue.items.map((item) => item.reportUuid), [REPORT_A.reportUuid]);
  assert.equal(initial.queue.hasMore, true);
  assert.equal(initial.queue.nextCursor, "cursor-page-2");

  const appended = await appendQueuePage(deps, initial.queue);
  assert.equal(appended.kind, "ok");
  if (appended.kind !== "ok") return;
  assert.deepEqual(
    appended.queue.items.map((item) => item.reportUuid),
    [REPORT_A.reportUuid, REPORT_B.reportUuid],
  );
  assert.equal(appended.queue.hasMore, false);
  assert.equal(appended.queue.nextCursor, null);

  const noop = await appendQueuePage(deps, appended.queue);
  assert.equal(noop.kind, "noop");
  assert.equal(queueCalls, 2);
});

test("403 on the initial queue load is a page-level refusal, not an empty queue", async () => {
  const { deps } = createRecordingFrankingDeps({
    getQueue: async () => {
      throw new ApiRequestError(403, NOT_REVIEWER);
    },
  });

  const outcome = await loadInitialQueue(deps);
  assert.equal(outcome.kind, "refusal");
  if (outcome.kind !== "refusal") return;
  assert.equal(outcome.failure.reason, "notReviewer");
  assert.equal(outcome.failure.message, NOT_REVIEWER);
  assert.notEqual(outcome.kind, "ok");
});

test("503 on the initial queue load surfaces roster-unavailable refusal text", async () => {
  const { deps } = createRecordingFrankingDeps({
    getQueue: async () => {
      throw new ApiRequestError(503, ROSTER_UNAVAILABLE);
    },
  });

  const outcome = await loadInitialQueue(deps);
  assert.equal(outcome.kind, "refusal");
  if (outcome.kind !== "refusal") return;
  assert.equal(outcome.failure.reason, "rosterUnavailable");
  assert.equal(outcome.failure.message, ROSTER_UNAVAILABLE);
});

test("409 on claim is a recoverable per-row failure with the server text", async () => {
  const { deps } = createRecordingFrankingDeps({
    claimReport: async () => {
      throw new ApiRequestError(409, ALREADY_CLAIMED);
    },
  });

  const outcome = await dispatchClaimReport(deps, REPORT_A.reportUuid);
  assert.equal(outcome.kind, "rowFailure");
  if (outcome.kind !== "rowFailure") return;
  assert.equal(outcome.failure.reason, "alreadyClaimed");
  assert.equal(outcome.failure.message, ALREADY_CLAIMED);
});

test("moderation logic never records a disclosure API call", async () => {
  const audit: FrankingAuditDto = { viewerAccountCount: 1, events: [] };
  const claimed: FrankingReportMetaDto = { ...REPORT_A, status: "claimed" };

  const { deps, calls } = createRecordingFrankingDeps({
    getQueue: async (cursor) =>
      cursor ? page([REPORT_B], null, false) : page([REPORT_A], "cursor-2", true),
    getReport: async () => REPORT_A,
    claimReport: async () => claimed,
    releaseReport: async () => ({ ...claimed, status: "open" }),
    resolveReport: async () => ({ ...claimed, status: "resolved" }),
    getAudit: async () => audit,
  });

  const initial = await loadInitialQueue(deps);
  assert.equal(initial.kind, "ok");
  if (initial.kind !== "ok") return;

  await appendQueuePage(deps, initial.queue);
  await deps.getReport(REPORT_A.reportUuid);
  await dispatchClaimReport(deps, REPORT_A.reportUuid);
  await deps.releaseReport(REPORT_A.reportUuid);
  await deps.resolveReport(REPORT_A.reportUuid, "rejected");
  await deps.getAudit(REPORT_A.reportUuid);

  assertAllowedFrankingCalls(calls);
  const recorded = new Set(calls.map((call) => call.operation));
  for (const operation of recorded) {
    assert.ok(
      (ALLOWED_FRANKING_API_CALLS as readonly string[]).includes(operation),
      `unexpected operation ${operation}`,
    );
  }
  assert.equal((recorded as Set<string>).has("disclosure"), false);

  const allowedSet = new Set<string>(ALLOWED_FRANKING_API_CALLS);
  for (const call of calls) {
    assert.ok(allowedSet.has(call.operation));
  }
});

test("open filter keeps only unclaimed reports", () => {
  const claimed: FrankingReportMetaDto = { ...REPORT_A, status: "claimed", claimedBy: "77777777-7777-7777-7777-777777777777" };
  const visible = filterQueueItems([REPORT_A, claimed], "open", null);
  assert.deepEqual(visible.map((item) => item.reportUuid), [REPORT_A.reportUuid]);
});

test("mine filter keeps claimed reports for the viewer", () => {
  const viewer = "77777777-7777-7777-7777-777777777777";
  const mine: FrankingReportMetaDto = { ...REPORT_A, status: "claimed", claimedBy: viewer };
  const other: FrankingReportMetaDto = {
    ...REPORT_B,
    status: "claimedAwaitingDisclosure",
    claimedBy: "88888888-8888-8888-8888-888888888888",
  };
  const visible = filterQueueItems([REPORT_A, mine, other], "mine", viewer);
  assert.deepEqual(visible.map((item) => item.reportUuid), [mine.reportUuid]);
});

test("closed filter is empty while the live queue has no resolved reports", () => {
  const visible = filterQueueItems([REPORT_A], "closed", null);
  assert.deepEqual(visible, []);
});

test("mergeReportIntoQueue replaces an existing row so a claim appears under mine", () => {
  const queue = { items: [REPORT_A, REPORT_B], nextCursor: null, hasMore: false };
  const claimed: FrankingReportMetaDto = {
    ...REPORT_A,
    status: "claimed",
    claimedBy: "77777777-7777-7777-7777-777777777777",
  };
  const merged = mergeReportIntoQueue(queue, claimed);
  assert.equal(merged.items[0]?.status, "claimed");
  assert.equal(merged.items[0]?.claimedBy, claimed.claimedBy);
  const mine = filterQueueItems(merged.items, "mine", claimed.claimedBy);
  assert.deepEqual(mine.map((item) => item.reportUuid), [REPORT_A.reportUuid]);
});

test("mergeReportIntoQueue inserts a claimed report that was not on the current page", () => {
  const queue = { items: [REPORT_B], nextCursor: null, hasMore: false };
  const claimed: FrankingReportMetaDto = {
    ...REPORT_A,
    status: "claimed",
    claimedBy: "77777777-7777-7777-7777-777777777777",
  };
  const merged = mergeReportIntoQueue(queue, claimed);
  assert.deepEqual(
    merged.items.map((item) => item.reportUuid),
    [REPORT_A.reportUuid, REPORT_B.reportUuid],
  );
});

test("canCloseAsClaimer follows the messaging rule: claimer on a live claim", () => {
  const viewer = "77777777-7777-7777-7777-777777777777";
  const claimed: FrankingReportMetaDto = { ...REPORT_A, status: "claimed", claimedBy: viewer };
  assert.equal(canResolveReport("claimed"), true);
  assert.equal(canResolveReport("claimedAwaitingDisclosure"), true);
  assert.equal(canCloseAsClaimer(claimed, viewer), true);
  assert.equal(canCloseAsClaimer(claimed, viewer.toUpperCase()), true);
  assert.equal(canCloseAsClaimer(claimed, "88888888-8888-8888-8888-888888888888"), false);
  assert.equal(
    canCloseAsClaimer({ ...claimed, status: "claimedAwaitingDisclosure" }, viewer),
    true,
  );
  assert.equal(canCloseAsClaimer({ ...claimed, status: "open", claimedBy: null }, viewer), false);
});

test("dispatchResolveReport forwards accountBlock on resolved and undefined on rejected", async () => {
  const claimed: FrankingReportMetaDto = { ...REPORT_A, status: "claimed" };
  let lastAccountBlock: unknown = "unset";

  const { deps } = createRecordingFrankingDeps({
    resolveReport: async (_reportUuid, decision, _code, accountBlock) => {
      lastAccountBlock = accountBlock;
      return { ...claimed, status: decision === "rejected" ? "rejected" : "resolved" };
    },
  });

  await dispatchResolveReport(deps, REPORT_A.reportUuid, "resolved", { days: 7 });
  assert.deepEqual(lastAccountBlock, { days: 7 });

  await dispatchResolveReport(deps, REPORT_A.reportUuid, "rejected");
  assert.equal(lastAccountBlock, undefined);
});

test("canReleaseAsClaimer is the claimer on a live claim, including awaiting disclosure", () => {
  const viewer = "77777777-7777-7777-7777-777777777777";
  const claimed: FrankingReportMetaDto = { ...REPORT_A, status: "claimed", claimedBy: viewer };
  assert.equal(canReleaseAsClaimer(claimed, viewer), true);
  assert.equal(
    canReleaseAsClaimer({ ...claimed, status: "claimedAwaitingDisclosure" }, viewer),
    true,
  );
  assert.equal(canReleaseAsClaimer(claimed, "88888888-8888-8888-8888-888888888888"), false);
  assert.equal(canReleaseAsClaimer({ ...claimed, status: "open", claimedBy: null }, viewer), false);
});
