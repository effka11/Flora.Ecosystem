import {
  decodeFscpBase64Url,
  getSodium,
  reviewFrankingComplaintDisclosureV1,
  unwrapReportContentKeyV1,
} from "@flora/fscp";
import {
  parseFrankingAudit,
  parseFrankingDisclosure,
  parseFrankingQueue,
  parseFrankingReportMeta,
  parseFrankingServerKey,
  type CreateFrankingReportRequest,
  type FrankingAuditDto,
  type FrankingDisclosureDto,
  type FrankingQueueDto,
  type FrankingReportMetaDto,
  type FrankingResolveDecision,
  type FrankingReviewerResult,
  type FrankingReviewerVerdict,
  type FrankingServerKeyDto,
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

export async function apiGetFrankingServerKey(): Promise<FrankingServerKeyDto> {
  const raw = await authGetJson("/api/messaging/franking/server-key");
  return parseFrankingServerKey(raw, ctx());
}

export async function apiGetFrankingWrapTargets(): Promise<FrankingWrapRosterDto> {
  const page = await apiGetFrankingServerKey();
  return { ...page.wrapTargets, reviewerRosterReady: page.reviewerRosterReady };
}

export async function apiGetFrankingDisclosure(reportUuid: string): Promise<FrankingDisclosureDto> {
  const raw = await authGetJson(`${reportPath(reportUuid)}/disclosure`);
  return parseFrankingDisclosure(raw, ctx());
}

function sameUuid(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function toReviewerVerdict(
  verification: ReturnType<typeof reviewFrankingComplaintDisclosureV1>["verification"],
): FrankingReviewerVerdict {
  if (verification.ok) return { ok: true };
  if (verification.reason === "unverifiable") {
    return { ok: false, reason: "unverifiable", missing: [...verification.missing] };
  }
  return { ok: false, reason: verification.reason };
}

export type ReviewFrankingDisclosureViewer = {
  persistedMessageUuid: string;
  viewerUserUuid: string;
  viewerDeviceUuid: string;
  agreementPrivateKey: Uint8Array;
};

/**
 * Crypto half of reviewer disclosure (no HTTP): parsed GET disclosure +
 * GET server-key + local unwrap material → `{ blocks, verified }`.
 */
export async function reviewFrankingDisclosureFromResponses(
  disclosure: FrankingDisclosureDto,
  serverKey: FrankingServerKeyDto,
  viewer: ReviewFrankingDisclosureViewer,
): Promise<FrankingReviewerResult> {
  const wrap = disclosure.wraps.find((item) => sameUuid(item.deviceUuid, viewer.viewerDeviceUuid));
  if (!wrap) {
    throw new Error("Нет ключа раскрытия для этого устройства.");
  }

  const publicKeyBase64Url = serverKey.publicKeyBase64Url?.trim() ?? "";
  if (!publicKeyBase64Url) {
    throw new Error("Серверный ключ франкования недоступен.");
  }

  const sodium = await getSodium();
  const serverFrankingPublicKey = decodeFscpBase64Url(sodium, publicKeyBase64Url);
  if (serverFrankingPublicKey.length !== 32) {
    throw new Error("Серверный ключ франкования недоступен.");
  }

  const agreementPrivateKey =
    viewer.agreementPrivateKey.length > 32
      ? viewer.agreementPrivateKey.subarray(0, 32)
      : viewer.agreementPrivateKey;
  const reportContentKey = unwrapReportContentKeyV1(sodium, {
    wrappedKey: wrap.wrappedKey,
    persistedMessageUuid: viewer.persistedMessageUuid,
    userUuid: viewer.viewerUserUuid,
    deviceUuid: viewer.viewerDeviceUuid,
    agreementPrivateKey,
  });

  const reviewed = reviewFrankingComplaintDisclosureV1(sodium, {
    sealed: disclosure.disclosureCiphertext,
    reportContentKey,
    serverFrankingPublicKey,
  });

  return {
    blocks: reviewed.plaintext?.blocks ?? null,
    verified: toReviewerVerdict(reviewed.verification),
  };
}

/**
 * One call for the Gov reviewer screen: report id → GET disclosure +
 * GET server-key → unwrap `reportContentKey` → `{ blocks, verified }`.
 * The screen does not import `@flora/fscp` or unwrap the wrap itself.
 */
export async function apiReviewFrankingReport(
  reportUuid: string,
  viewer: ReviewFrankingDisclosureViewer,
): Promise<FrankingReviewerResult> {
  const [disclosure, serverKey] = await Promise.all([
    apiGetFrankingDisclosure(reportUuid),
    apiGetFrankingServerKey(),
  ]);
  return reviewFrankingDisclosureFromResponses(disclosure, serverKey, viewer);
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

export type {
  CreateFrankingReportRequest,
  FrankingDisclosureDto,
  FrankingResolveDecision,
  FrankingReviewerResult,
  FrankingReviewerVerdict,
  FrankingServerKeyDto,
  FrankingWrapTargetsDto,
};
