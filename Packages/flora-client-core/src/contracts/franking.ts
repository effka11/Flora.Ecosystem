import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type FrankingReportCategory = "abuse" | "threats" | "spam" | "csam" | "other";

export const FRANKING_REPORT_CATEGORIES: readonly FrankingReportCategory[] = [
  "abuse",
  "threats",
  "spam",
  "csam",
  "other",
];

export type ServerFrankReceiptDto = {
  signatureBase64Url: string;
  serverFrankingKeyId: string;
  serverReceivedAt: string;
};

export function parseServerFrankReceipt(
  raw: unknown,
  ctx?: ParseContext,
): ServerFrankReceiptDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const signatureBase64Url = readStr(o, ["signatureBase64Url", "SignatureBase64Url"], fb);
  const serverFrankingKeyId = readStr(o, ["serverFrankingKeyId", "ServerFrankingKeyId"], fb);
  const serverReceivedAt = readStr(o, ["serverReceivedAt", "ServerReceivedAt"], fb);
  if (!signatureBase64Url || !serverFrankingKeyId || !serverReceivedAt) return null;
  return { signatureBase64Url, serverFrankingKeyId, serverReceivedAt };
}

export function parseMessageFrankingFields(
  raw: Record<string, unknown>,
  ctx?: ParseContext,
): {
  serverFrankReceipt: ServerFrankReceiptDto | null;
  frankTagBase64Url: string | null;
} {
  const fb = ctx?.onPascalFallback;
  const frankTagBase64Url = readStr(raw, ["frankTagBase64Url", "FrankTagBase64Url"], fb);
  return {
    serverFrankReceipt: parseServerFrankReceipt(
      raw.serverFrankReceipt ?? raw.ServerFrankReceipt,
      ctx,
    ),
    frankTagBase64Url: frankTagBase64Url.length > 0 ? frankTagBase64Url : null,
  };
}

export type FrankingDisclosureWrapDto = {
  userUuid: string;
  deviceUuid: string;
  wrappedKey: string;
};

export type FrankingWrapTargetDto = {
  userUuid: string;
  deviceUuid: string;
  agreementPublicKeyBase64Url: string;
};

export type FrankingWrapTargetsDto = {
  items: FrankingWrapTargetDto[];
  ownItems: FrankingWrapTargetDto[];
};

function parseWrapTargetList(raw: unknown, ctx?: ParseContext): FrankingWrapTargetDto[] {
  if (!Array.isArray(raw)) return [];
  const fb = ctx?.onPascalFallback;
  return raw.flatMap((item) => {
    const row = asRecord(item);
    if (!row) return [];
    const userUuid = readStr(row, ["userUuid", "UserUuid"], fb);
    const deviceUuid = readStr(row, ["deviceUuid", "DeviceUuid"], fb);
    const agreementPublicKeyBase64Url = readStr(
      row,
      ["agreementPublicKeyBase64Url", "AgreementPublicKeyBase64Url"],
      fb,
    );
    return userUuid && deviceUuid && agreementPublicKeyBase64Url
      ? [{ userUuid, deviceUuid, agreementPublicKeyBase64Url }]
      : [];
  });
}

function rosterReadyFlag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

export function parseFrankingWrapTargets(raw: unknown, ctx?: ParseContext): FrankingWrapTargetsDto {
  const o = asRecord(raw);
  if (!o) return { items: [], ownItems: [] };
  return {
    items: parseWrapTargetList(o.items ?? o.Items, ctx),
    ownItems: parseWrapTargetList(o.ownItems ?? o.OwnItems, ctx),
  };
}

export type FrankingServerKeyDto = {
  serverFrankingKeyId: string | null;
  publicKeyBase64Url: string | null;
  wrapTargets: FrankingWrapTargetsDto;
  reviewerRosterReady: boolean;
};

export function parseFrankingServerKey(raw: unknown, ctx?: ParseContext): FrankingServerKeyDto {
  const o = asRecord(raw);
  if (!o) {
    return {
      serverFrankingKeyId: null,
      publicKeyBase64Url: null,
      wrapTargets: { items: [], ownItems: [] },
      reviewerRosterReady: true,
    };
  }
  const fb = ctx?.onPascalFallback;
  return {
    serverFrankingKeyId: readStr(o, ["serverFrankingKeyId", "ServerFrankingKeyId"], fb) || null,
    publicKeyBase64Url: readStr(o, ["publicKeyBase64Url", "PublicKeyBase64Url"], fb) || null,
    wrapTargets: parseFrankingWrapTargets(o.wrapTargets ?? o.WrapTargets, ctx),
    reviewerRosterReady: rosterReadyFlag(o.reviewerRosterReady ?? o.ReviewerRosterReady, true),
  };
}

export type CreateFrankingReportRequest = {
  persistedMessageUuid: string;
  category: FrankingReportCategory;
  disclosureCiphertext: string;
  wraps?: FrankingDisclosureWrapDto[];
};

export type FrankingReportStatus =
  | "open"
  | "claimed"
  | "claimedAwaitingDisclosure"
  | "resolved"
  | "rejected";

export type FrankingVerificationStatus = "verifiable" | "unverifiable";

export type FrankingAuditEvent =
  | "wrapCreated"
  | "wrapDestroyed"
  | "claimed"
  | "released"
  | "forwarded"
  | "disclosureFetched"
  | "resolved"
  | "rejected";

export type FrankingResolveDecision = "resolved" | "rejected";

export type FrankingReportMetaDto = {
  reportUuid: string;
  persistedMessageUuid: string;
  conversationUuid: string;
  category: FrankingReportCategory;
  status: FrankingReportStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  createdAt: string;
  viewerAccountCount: number;
  hasDisclosure: boolean;
  verificationStatus: FrankingVerificationStatus;
  reporterUsername: string | null;
  accusedUsername: string | null;
};

export type FrankingQueueDto = {
  items: FrankingReportMetaDto[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type FrankingAuditEventDto = {
  auditUuid: string;
  event: FrankingAuditEvent;
  actorUserUuid: string;
  subjectUserUuid: string | null;
  createdAt: string;
};

export type FrankingAuditDto = {
  viewerAccountCount: number;
  events: FrankingAuditEventDto[];
};

function parseFrankingReportCategory(raw: unknown): FrankingReportCategory | null {
  if (raw === "abuse") return "abuse";
  if (raw === "threats") return "threats";
  if (raw === "spam") return "spam";
  if (raw === "csam") return "csam";
  if (raw === "other") return "other";
  return null;
}

function parseFrankingReportStatus(raw: unknown): FrankingReportStatus | null {
  if (raw === "open") return "open";
  if (raw === "claimed") return "claimed";
  if (raw === "claimedAwaitingDisclosure") return "claimedAwaitingDisclosure";
  if (raw === "resolved") return "resolved";
  if (raw === "rejected") return "rejected";
  return null;
}

function parseFrankingVerificationStatus(raw: unknown): FrankingVerificationStatus | null {
  if (raw === "verifiable") return "verifiable";
  if (raw === "unverifiable") return "unverifiable";
  return null;
}

function parseFrankingAuditEvent(raw: unknown): FrankingAuditEvent | null {
  if (raw === "wrapCreated") return "wrapCreated";
  if (raw === "wrapDestroyed") return "wrapDestroyed";
  if (raw === "claimed") return "claimed";
  if (raw === "released") return "released";
  if (raw === "forwarded") return "forwarded";
  if (raw === "disclosureFetched") return "disclosureFetched";
  if (raw === "resolved") return "resolved";
  if (raw === "rejected") return "rejected";
  return null;
}

function parseFrankingReportMetaItem(raw: unknown, ctx?: ParseContext): FrankingReportMetaDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const reportUuid = readStr(o, ["reportUuid", "ReportUuid"], fb);
  if (!reportUuid) return null;

  const category = parseFrankingReportCategory(readStr(o, ["category", "Category"], fb));
  if (!category) return null;

  const status = parseFrankingReportStatus(readStr(o, ["status", "Status"], fb));
  if (!status) return null;

  const verificationStatus = parseFrankingVerificationStatus(
    readStr(o, ["verificationStatus", "VerificationStatus"], fb),
  );
  if (!verificationStatus) return null;

  return {
    reportUuid,
    persistedMessageUuid: readStr(o, ["persistedMessageUuid", "PersistedMessageUuid"], fb),
    conversationUuid: readStr(o, ["conversationUuid", "ConversationUuid"], fb),
    category,
    status,
    claimedBy: readStr(o, ["claimedBy", "ClaimedBy"], fb) || null,
    claimedAt: readStr(o, ["claimedAt", "ClaimedAt"], fb) || null,
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    viewerAccountCount: readNum(o, ["viewerAccountCount", "ViewerAccountCount"], fb) ?? 0,
    hasDisclosure: readBool(o, ["hasDisclosure", "HasDisclosure"], fb),
    verificationStatus,
    reporterUsername: readStr(o, ["reporterUsername", "ReporterUsername"], fb) || null,
    accusedUsername: readStr(o, ["accusedUsername", "AccusedUsername"], fb) || null,
  };
}

export function parseFrankingReportMeta(raw: unknown, ctx?: ParseContext): FrankingReportMetaDto {
  const parsed = parseFrankingReportMetaItem(raw, ctx);
  if (!parsed) throw new Error("Некорректный ответ: нет reportUuid заявки franking.");
  return parsed;
}

export function parseFrankingQueue(raw: unknown, ctx?: ParseContext): FrankingQueueDto {
  const o = asRecord(raw);
  if (!o) return { items: [], nextCursor: null, hasMore: false };
  const fb = ctx?.onPascalFallback;
  const itemsRaw = o.items ?? o.Items;
  const items = Array.isArray(itemsRaw)
    ? itemsRaw
        .map((x) => parseFrankingReportMetaItem(x, ctx))
        .filter((x): x is FrankingReportMetaDto => x !== null)
    : [];
  return {
    items,
    nextCursor: readStr(o, ["nextCursor", "NextCursor"], fb) || null,
    hasMore: readBool(o, ["hasMore", "HasMore"], fb),
  };
}

function parseFrankingAuditEventItem(raw: unknown, ctx?: ParseContext): FrankingAuditEventDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const auditUuid = readStr(o, ["auditUuid", "AuditUuid"], fb);
  if (!auditUuid) return null;

  const event = parseFrankingAuditEvent(readStr(o, ["event", "Event"], fb));
  if (!event) return null;

  const actorUserUuid = readStr(o, ["actorUserUuid", "ActorUserUuid"], fb);
  if (!actorUserUuid) return null;

  return {
    auditUuid,
    event,
    actorUserUuid,
    subjectUserUuid: readStr(o, ["subjectUserUuid", "SubjectUserUuid"], fb) || null,
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
  };
}

export function parseFrankingAudit(raw: unknown, ctx?: ParseContext): FrankingAuditDto {
  const o = asRecord(raw) ?? {};
  const fb = ctx?.onPascalFallback;
  const eventsRaw = o.events ?? o.Events;
  const events = Array.isArray(eventsRaw)
    ? eventsRaw
        .map((x) => parseFrankingAuditEventItem(x, ctx))
        .filter((x): x is FrankingAuditEventDto => x !== null)
    : [];
  return {
    viewerAccountCount: readNum(o, ["viewerAccountCount", "ViewerAccountCount"], fb) ?? 0,
    events,
  };
}
