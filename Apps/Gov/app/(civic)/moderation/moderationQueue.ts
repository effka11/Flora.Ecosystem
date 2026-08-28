import { toFrankingFailure, type FrankingFailure } from "@flora/client-core/api";
import type {
  FrankingAuditDto,
  FrankingQueueDto,
  FrankingReportMetaDto,
  FrankingResolveDecision,
  FrankingReviewerResult,
} from "@flora/client-core/contracts";
import type { FrankingAccountBlockRequest } from "@flora/client-core/api";

/** Allowed franking HTTP surfaces for this slice. Disclosure only after claim. */
export const ALLOWED_FRANKING_API_CALLS = [
  "queue",
  "get",
  "claim",
  "release",
  "resolve",
  "audit",
  "disclosure",
] as const;

export type FrankingApiOperation = (typeof ALLOWED_FRANKING_API_CALLS)[number];

export type ReviewFrankingReportInput = {
  reportUuid: string;
  persistedMessageUuid: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
};

export type ModerationFrankingDeps = {
  getQueue: (cursor?: string) => Promise<FrankingQueueDto>;
  getReport: (reportUuid: string) => Promise<FrankingReportMetaDto>;
  claimReport: (reportUuid: string) => Promise<FrankingReportMetaDto>;
  releaseReport: (reportUuid: string) => Promise<FrankingReportMetaDto>;
  resolveReport: (
    reportUuid: string,
    decision: FrankingResolveDecision,
    code?: string,
    accountBlock?: FrankingAccountBlockRequest,
  ) => Promise<FrankingReportMetaDto>;
  getAudit: (reportUuid: string) => Promise<FrankingAuditDto>;
  reviewReport: (input: ReviewFrankingReportInput) => Promise<FrankingReviewerResult>;
};

export type RecordedFrankingCall = {
  operation: FrankingApiOperation;
  args: unknown[];
};

export type QueueAccumulator = {
  items: FrankingReportMetaDto[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type QueueLoadOutcome =
  | { kind: "ok"; queue: QueueAccumulator }
  | { kind: "refusal"; failure: FrankingFailure };

export type QueueAppendOutcome =
  | { kind: "ok"; queue: QueueAccumulator }
  | { kind: "refusal"; failure: FrankingFailure }
  | { kind: "noop"; queue: QueueAccumulator };

export type RowActionOutcome =
  | { kind: "ok"; report: FrankingReportMetaDto }
  | { kind: "rowFailure"; failure: FrankingFailure }
  | { kind: "pageFailure"; failure: FrankingFailure };

export function isPageLevelFrankingFailure(failure: FrankingFailure): boolean {
  return failure.reason === "notReviewer" || failure.reason === "rosterUnavailable";
}

export function isRecoverableRowFailure(failure: FrankingFailure): boolean {
  return failure.reason === "alreadyClaimed";
}

export function canClaimReport(status: FrankingReportMetaDto["status"]): boolean {
  return status === "open";
}

export function canReleaseReport(status: FrankingReportMetaDto["status"]): boolean {
  return status === "claimed" || status === "claimedAwaitingDisclosure";
}

/** Resolve/reject HTTP: claimer only, from a live claim (with or without wrap). */
export function canResolveReport(status: FrankingReportMetaDto["status"]): boolean {
  return status === "claimed" || status === "claimedAwaitingDisclosure";
}

function sameUserUuid(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = left?.trim().toLowerCase() ?? "";
  const b = right?.trim().toLowerCase() ?? "";
  return Boolean(a && b && a === b);
}

/** Matches flora-messaging: close is claimer + live claim. */
export function canCloseAsClaimer(
  report: FrankingReportMetaDto,
  viewerUserUuid: string | null,
): boolean {
  return canResolveReport(report.status) && sameUserUuid(report.claimedBy, viewerUserUuid);
}

/** Matches flora-messaging: only the claimer can release a live claim. */
export function canReleaseAsClaimer(
  report: FrankingReportMetaDto,
  viewerUserUuid: string | null,
): boolean {
  return canReleaseReport(report.status) && sameUserUuid(report.claimedBy, viewerUserUuid);
}

export type ModerationQueueFilter = "open" | "mine" | "closed";

export const MODERATION_QUEUE_FILTERS: readonly {
  id: ModerationQueueFilter;
  label: string;
}[] = [
  { id: "open", label: "Открытые заявки" },
  { id: "mine", label: "Ваши заявки" },
  { id: "closed", label: "Ваши закрытые заявки" },
];

export function filterQueueItems(
  items: readonly FrankingReportMetaDto[],
  filter: ModerationQueueFilter,
  viewerUserUuid: string | null,
): FrankingReportMetaDto[] {
  switch (filter) {
    case "open":
      return items.filter((item) => item.status === "open");
    case "mine": {
      const viewer = viewerUserUuid?.trim() || null;
      return items.filter((item) => {
        if (item.status !== "claimed" && item.status !== "claimedAwaitingDisclosure") {
          return false;
        }
        if (!viewer || !item.claimedBy) return true;
        return item.claimedBy === viewer;
      });
    }
    case "closed":
      return items.filter((item) => item.status === "resolved" || item.status === "rejected");
  }
}

function mergeUniqueReports(
  existing: FrankingReportMetaDto[],
  incoming: FrankingReportMetaDto[],
): FrankingReportMetaDto[] {
  const seen = new Set(existing.map((item) => item.reportUuid));
  const merged = [...existing];
  for (const item of incoming) {
    if (seen.has(item.reportUuid)) continue;
    seen.add(item.reportUuid);
    merged.push(item);
  }
  return merged;
}

export function mergeReportIntoQueue(
  queue: QueueAccumulator,
  report: FrankingReportMetaDto,
): QueueAccumulator {
  const index = queue.items.findIndex((item) => item.reportUuid === report.reportUuid);
  if (index === -1) {
    return { ...queue, items: [report, ...queue.items] };
  }
  const items = queue.items.slice();
  items[index] = report;
  return { ...queue, items };
}

export async function loadInitialQueue(
  deps: ModerationFrankingDeps,
): Promise<QueueLoadOutcome> {
  try {
    const page = await deps.getQueue();
    return {
      kind: "ok",
      queue: {
        items: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      },
    };
  } catch (error: unknown) {
    const failure = toFrankingFailure(error);
    if (failure && isPageLevelFrankingFailure(failure)) {
      return { kind: "refusal", failure };
    }
    throw error;
  }
}

export async function appendQueuePage(
  deps: ModerationFrankingDeps,
  queue: QueueAccumulator,
): Promise<QueueAppendOutcome> {
  if (!queue.hasMore || !queue.nextCursor) {
    return { kind: "noop", queue };
  }

  try {
    const page = await deps.getQueue(queue.nextCursor);
    return {
      kind: "ok",
      queue: {
        items: mergeUniqueReports(queue.items, page.items),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      },
    };
  } catch (error: unknown) {
    const failure = toFrankingFailure(error);
    if (failure && isPageLevelFrankingFailure(failure)) {
      return { kind: "refusal", failure };
    }
    throw error;
  }
}

function mapActionFailure(error: unknown): RowActionOutcome {
  const failure = toFrankingFailure(error);
  if (!failure) throw error;
  if (isPageLevelFrankingFailure(failure)) {
    return { kind: "pageFailure", failure };
  }
  if (isRecoverableRowFailure(failure)) {
    return { kind: "rowFailure", failure };
  }
  return { kind: "rowFailure", failure };
}

export async function dispatchClaimReport(
  deps: ModerationFrankingDeps,
  reportUuid: string,
): Promise<RowActionOutcome> {
  try {
    const report = await deps.claimReport(reportUuid);
    return { kind: "ok", report };
  } catch (error: unknown) {
    return mapActionFailure(error);
  }
}

export async function dispatchReleaseReport(
  deps: ModerationFrankingDeps,
  reportUuid: string,
): Promise<RowActionOutcome> {
  try {
    const report = await deps.releaseReport(reportUuid);
    return { kind: "ok", report };
  } catch (error: unknown) {
    return mapActionFailure(error);
  }
}

export async function dispatchResolveReport(
  deps: ModerationFrankingDeps,
  reportUuid: string,
  decision: FrankingResolveDecision,
  accountBlock?: FrankingAccountBlockRequest,
): Promise<RowActionOutcome> {
  try {
    const report = await deps.resolveReport(reportUuid, decision, undefined, accountBlock);
    return { kind: "ok", report };
  } catch (error: unknown) {
    return mapActionFailure(error);
  }
}

export async function loadReportAudit(
  deps: ModerationFrankingDeps,
  reportUuid: string,
): Promise<FrankingAuditDto> {
  return deps.getAudit(reportUuid);
}

export async function refreshReportMeta(
  deps: ModerationFrankingDeps,
  reportUuid: string,
): Promise<FrankingReportMetaDto> {
  return deps.getReport(reportUuid);
}

/** Test helper: records every dependency call and rejects disallowed operations. */
export function createRecordingFrankingDeps(handlers: {
  getQueue?: (cursor?: string) => Promise<FrankingQueueDto>;
  getReport?: (reportUuid: string) => Promise<FrankingReportMetaDto>;
  claimReport?: (reportUuid: string) => Promise<FrankingReportMetaDto>;
  releaseReport?: (reportUuid: string) => Promise<FrankingReportMetaDto>;
  resolveReport?: (
    reportUuid: string,
    decision: FrankingResolveDecision,
    code?: string,
    accountBlock?: FrankingAccountBlockRequest,
  ) => Promise<FrankingReportMetaDto>;
  getAudit?: (reportUuid: string) => Promise<FrankingAuditDto>;
  reviewReport?: (input: ReviewFrankingReportInput) => Promise<FrankingReviewerResult>;
}): { deps: ModerationFrankingDeps; calls: RecordedFrankingCall[] } {
  const calls: RecordedFrankingCall[] = [];

  const record = (operation: FrankingApiOperation, args: unknown[]) => {
    calls.push({ operation, args });
  };

  const deps: ModerationFrankingDeps = {
    async getQueue(cursor) {
      record("queue", cursor === undefined ? [] : [cursor]);
      if (!handlers.getQueue) throw new Error("getQueue handler missing");
      return handlers.getQueue(cursor);
    },
    async getReport(reportUuid) {
      record("get", [reportUuid]);
      if (!handlers.getReport) throw new Error("getReport handler missing");
      return handlers.getReport(reportUuid);
    },
    async claimReport(reportUuid) {
      record("claim", [reportUuid]);
      if (!handlers.claimReport) throw new Error("claimReport handler missing");
      return handlers.claimReport(reportUuid);
    },
    async releaseReport(reportUuid) {
      record("release", [reportUuid]);
      if (!handlers.releaseReport) throw new Error("releaseReport handler missing");
      return handlers.releaseReport(reportUuid);
    },
    async resolveReport(reportUuid, decision, code, accountBlock) {
      record(
        "resolve",
        accountBlock === undefined
          ? code === undefined
            ? [reportUuid, decision]
            : [reportUuid, decision, code]
          : code === undefined
            ? [reportUuid, decision, undefined, accountBlock]
            : [reportUuid, decision, code, accountBlock],
      );
      if (!handlers.resolveReport) throw new Error("resolveReport handler missing");
      return handlers.resolveReport(reportUuid, decision, code, accountBlock);
    },
    async getAudit(reportUuid) {
      record("audit", [reportUuid]);
      if (!handlers.getAudit) throw new Error("getAudit handler missing");
      return handlers.getAudit(reportUuid);
    },
    async reviewReport(input) {
      record("disclosure", [input.reportUuid, input.persistedMessageUuid, input.viewerUserUuid]);
      if (!handlers.reviewReport) throw new Error("reviewReport handler missing");
      return handlers.reviewReport(input);
    },
  };

  return { deps, calls };
}

export function assertAllowedFrankingCalls(calls: RecordedFrankingCall[]): void {
  const allowed = new Set<string>(ALLOWED_FRANKING_API_CALLS);
  for (const call of calls) {
    if (!allowed.has(call.operation)) {
      throw new Error(`Disallowed franking operation: ${call.operation}`);
    }
  }
}
