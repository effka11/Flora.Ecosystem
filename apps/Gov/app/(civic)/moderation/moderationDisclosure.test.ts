import assert from "node:assert/strict";
import test from "node:test";
import { ApiRequestError, FRANKING_NO_DEVICE_WRAP_MESSAGE } from "@flora/client-core/api";
import type { FrankingReportMetaDto } from "@flora/client-core/contracts";
import {
  classifyDisclosureLoadError,
  loadAnketaDisclosure,
  presentAnketaDisclosureView,
  resolveAnketaDisclosureIntent,
} from "./moderationDisclosure";
import { createRecordingFrankingDeps } from "./moderationQueue";

const VIEWER = "77777777-7777-7777-7777-777777777777";
const KEY = new Uint8Array(32);

const CLAIMED: FrankingReportMetaDto = {
  reportUuid: "11111111-1111-1111-1111-111111111111",
  persistedMessageUuid: "22222222-2222-2222-2222-222222222222",
  conversationUuid: "33333333-3333-3333-3333-333333333333",
  category: "abuse",
  status: "claimed",
  claimedBy: VIEWER,
  claimedAt: "2026-08-17T12:01:00.000Z",
  createdAt: "2026-08-17T12:00:00.000Z",
  viewerAccountCount: 1,
  hasDisclosure: true,
  verificationStatus: "verifiable",
  reporterUsername: "alice",
  accusedUsername: "bob",
};

test("presentAnketaDisclosureView stays idle/unlock without a fetch, then shows keyed result", () => {
  assert.equal(presentAnketaDisclosureView({
    intent: "idle",
    bootstrapLoading: false,
    keysReady: true,
    fetched: null,
    fetchKey: "k",
  }).phase, "idle");
  assert.equal(presentAnketaDisclosureView({
    intent: "unlock",
    bootstrapLoading: true,
    keysReady: false,
    fetched: null,
    fetchKey: "k",
  }).phase, "loading");
  assert.equal(presentAnketaDisclosureView({
    intent: "fetch",
    bootstrapLoading: false,
    keysReady: true,
    fetched: null,
    fetchKey: "k",
  }).phase, "loading");
  assert.equal(
    presentAnketaDisclosureView({
      intent: "fetch",
      bootstrapLoading: false,
      keysReady: true,
      fetched: { key: "k", view: { phase: "waiting" } },
      fetchKey: "k",
    }).phase,
    "waiting",
  );
});

test("open does not fetch disclosure; live claim fetches when keys are ready", () => {
  assert.equal(resolveAnketaDisclosureIntent("open", true), "idle");
  assert.equal(resolveAnketaDisclosureIntent("claimedAwaitingDisclosure", false), "unlock");
  assert.equal(resolveAnketaDisclosureIntent("claimedAwaitingDisclosure", true), "fetch");
  assert.equal(resolveAnketaDisclosureIntent("claimed", false), "unlock");
  assert.equal(resolveAnketaDisclosureIntent("claimed", true), "fetch");
});

test("claimed reviewReport is called with persistedMessageUuid from meta", async () => {
  const { deps, calls } = createRecordingFrankingDeps({
    reviewReport: async () => ({
      blocks: [{ kind: "text", body: "текст жалобы" }],
      verified: { ok: true },
    }),
  });

  const view = await loadAnketaDisclosure({
    deps,
    report: CLAIMED,
    viewerUserUuid: VIEWER,
    agreementPrivateKey: KEY,
  });

  assert.equal(view.phase, "ready");
  if (view.phase !== "ready") return;
  assert.deepEqual(view.result.blocks, [{ kind: "text", body: "текст жалобы" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operation, "disclosure");
  assert.deepEqual(calls[0]?.args, [CLAIMED.reportUuid, CLAIMED.persistedMessageUuid, VIEWER]);
});

test("claimedAwaitingDisclosure still requests disclosure with persistedMessageUuid", async () => {
  const awaiting: FrankingReportMetaDto = { ...CLAIMED, status: "claimedAwaitingDisclosure" };
  const { deps, calls } = createRecordingFrankingDeps({
    reviewReport: async () => ({
      blocks: [{ kind: "text", body: "после claim" }],
      verified: { ok: true },
    }),
  });

  const view = await loadAnketaDisclosure({
    deps,
    report: awaiting,
    viewerUserUuid: VIEWER,
    agreementPrivateKey: KEY,
  });

  assert.equal(view.phase, "ready");
  if (view.phase !== "ready") return;
  assert.deepEqual(view.result.blocks, [{ kind: "text", body: "после claim" }]);
  assert.equal(calls[0]?.operation, "disclosure");
  assert.deepEqual(calls[0]?.args, [awaiting.reportUuid, awaiting.persistedMessageUuid, VIEWER]);
});

test("open queue flow does not record a disclosure API call", async () => {
  const { deps, calls } = createRecordingFrankingDeps({
    getQueue: async () => ({ items: [{ ...CLAIMED, status: "open", claimedBy: null }], nextCursor: null, hasMore: false }),
  });
  await deps.getQueue();
  assert.equal(calls.some((call) => call.operation === "disclosure"), false);
  assert.equal(resolveAnketaDisclosureIntent("open", true), "idle");
});

test("403 no_wrap is waiting, not a crypto failure", () => {
  assert.equal(
    classifyDisclosureLoadError(
      new ApiRequestError(403, "Нет viewer-wrap: ожидается раскрытие от жалобщика."),
    ),
    "waiting",
  );
  assert.equal(
    classifyDisclosureLoadError(new ApiRequestError(403, "Нет доступа.", "no_wrap")),
    "waiting",
  );
});

test("403 without no_wrap is a disclosure error, not waiting", () => {
  assert.equal(
    classifyDisclosureLoadError(new ApiRequestError(403, "Нет доступа к наполнению.")),
    "error",
  );
  assert.equal(
    classifyDisclosureLoadError(new ApiRequestError(403, "Заявка закрыта.")),
    "error",
  );
});

test("pubkey mismatch is a disclosure error, not waiting", async () => {
  assert.equal(classifyDisclosureLoadError(new Error(FRANKING_NO_DEVICE_WRAP_MESSAGE)), "mismatch");

  const { deps } = createRecordingFrankingDeps({
    reviewReport: async () => {
      throw new Error(FRANKING_NO_DEVICE_WRAP_MESSAGE);
    },
  });
  const view = await loadAnketaDisclosure({
    deps,
    report: CLAIMED,
    viewerUserUuid: VIEWER,
    agreementPrivateKey: KEY,
  });
  assert.equal(view.phase, "mismatch");
  if (view.phase !== "mismatch") return;
  assert.equal(view.message, FRANKING_NO_DEVICE_WRAP_MESSAGE);
});

test("disclosure 403 load becomes waiting", async () => {
  const { deps } = createRecordingFrankingDeps({
    reviewReport: async () => {
      throw new ApiRequestError(403, "Нет viewer-wrap: ожидается раскрытие от жалобщика.");
    },
  });
  const view = await loadAnketaDisclosure({
    deps,
    report: CLAIMED,
    viewerUserUuid: VIEWER,
    agreementPrivateKey: KEY,
  });
  assert.equal(view.phase, "waiting");
});
