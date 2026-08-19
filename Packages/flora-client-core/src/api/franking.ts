import {
  parseFrankingServerKey,
  parseFrankingAudit,
  parseFrankingQueue,
  parseFrankingReportMeta,
  type CreateFrankingReportRequest,
  type FrankingAuditDto,
  type FrankingQueueDto,
  type FrankingReportMetaDto,
  type FrankingResolveDecision,
  type FrankingWrapTargetsDto,
} from "../contracts/franking.js";
import { authGetJson, authPostJson, getApiClientConfig } from "./client.js";
import { isApiRequestError } from "./errors.js";

function ctx() {
  return { onPascalFallback: getApiClientConfig().onPascalFallback };
}

function reportPath(reportUuid: string): string {
  return `/api/messaging/franking/reports/${encodeURIComponent(reportUuid.trim())}`;
}

export type FrankingFailureReason =
  | "notReviewer"
  | "alreadyClaimed"
  | "rosterUnavailable"
  | "notFound"
  | "unauthorized"
  | "badRequest"
  | "unknown";

export type FrankingFailure = {
  reason: FrankingFailureReason;
  status: number;
  message: string;
};

/** Resolve body: `{}` without `days` means forever; omit the whole key for no ban. */
export type FrankingAccountBlockRequest = {
  days?: number;
};

export function toFrankingFailure(err: unknown): FrankingFailure | null {
  if (!isApiRequestError(err)) return null;
  let reason: FrankingFailureReason;
  switch (err.status) {
    case 403:
      reason = "notReviewer";
      break;
    case 409:
      reason = "alreadyClaimed";
      break;
    case 503:
      reason = "rosterUnavailable";
      break;
    case 404:
      reason = "notFound";
      break;
    case 401:
      reason = "unauthorized";
      break;
    case 400:
      reason = "badRequest";
      break;
    default:
      reason = "unknown";
  }
  return { reason, status: err.status, message: err.message };
}

export async function apiGetFrankingQueue(cursor?: string): Promise<FrankingQueueDto> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const raw = await authGetJson(`/api/messaging/franking/queue${q}`);
  return parseFrankingQueue(raw, ctx());
}

export async function apiGetFrankingReport(reportUuid: string): Promise<FrankingReportMetaDto> {
  const raw = await authGetJson(reportPath(reportUuid));
  return parseFrankingReportMeta(raw, ctx());
}

export async function apiClaimFrankingReport(reportUuid: string): Promise<FrankingReportMetaDto> {
  const raw = await authPostJson(`${reportPath(reportUuid)}/claim`, {});
  return parseFrankingReportMeta(raw, ctx());
}

export async function apiReleaseFrankingReport(reportUuid: string): Promise<FrankingReportMetaDto> {
  const raw = await authPostJson(`${reportPath(reportUuid)}/release`, {});
  return parseFrankingReportMeta(raw, ctx());
}

export async function apiResolveFrankingReport(
  reportUuid: string,
  decision: FrankingResolveDecision,
  code?: string,
  accountBlock?: FrankingAccountBlockRequest,
): Promise<FrankingReportMetaDto> {
  const body: Record<string, unknown> = { decision };
  if (code !== undefined) {
    body.code = code;
  }
  if (decision !== "rejected" && accountBlock !== undefined) {
    body.accountBlock =
      accountBlock.days !== undefined ? { days: accountBlock.days } : {};
  }
  const raw = await authPostJson(`${reportPath(reportUuid)}/resolve`, body);
  return parseFrankingReportMeta(raw, ctx());
}

export async function apiGetFrankingAudit(reportUuid: string): Promise<FrankingAuditDto> {
  const raw = await authGetJson(`${reportPath(reportUuid)}/audit`);
  return parseFrankingAudit(raw, ctx());
}

export type FrankingWrapRosterDto = FrankingWrapTargetsDto & {
  reviewerRosterReady: boolean;
};

export async function apiGetFrankingWrapTargets(): Promise<FrankingWrapRosterDto> {
  const raw = await authGetJson("/api/messaging/franking/server-key");
  const page = parseFrankingServerKey(raw, ctx());
  return { ...page.wrapTargets, reviewerRosterReady: page.reviewerRosterReady };
}

export async function apiCreateFrankingReport(
  body: CreateFrankingReportRequest,
): Promise<FrankingReportMetaDto> {
  const payload: Record<string, unknown> = {
    persistedMessageUuid: body.persistedMessageUuid,
    category: body.category,
    disclosureCiphertext: body.disclosureCiphertext,
    wraps: body.wraps ?? [],
  };
  const raw = await authPostJson("/api/messaging/franking/reports", payload);
  return parseFrankingReportMeta(raw, ctx());
}

export type { CreateFrankingReportRequest, FrankingResolveDecision, FrankingWrapTargetsDto };
