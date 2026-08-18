import type {
  FrankingAuditEvent,
  FrankingReportCategory,
  FrankingReportStatus,
  FrankingVerificationStatus,
} from "@flora/client-core/contracts";

const CATEGORY_LABELS: Record<FrankingReportCategory, string> = {
  abuse: "Злоупотребление",
  threats: "Угрозы",
  spam: "Спам",
  csam: "CSAM",
  other: "Другое",
};

const STATUS_LABELS: Record<FrankingReportStatus, string> = {
  open: "Открыта",
  claimed: "Занята",
  claimedAwaitingDisclosure: "Ожидает раскрытия",
  resolved: "Закрыта",
  rejected: "Отклонена",
};

const VERIFICATION_LABELS: Record<FrankingVerificationStatus, string> = {
  verifiable: "Верифицируемая",
  unverifiable: "Неверифицируемая",
};

const AUDIT_EVENT_LABELS: Record<FrankingAuditEvent, string> = {
  wrapCreated: "Создан wrap",
  wrapDestroyed: "Wrap уничтожен",
  claimed: "Занята",
  released: "Освобождена",
  forwarded: "Передана",
  disclosureFetched: "Раскрытие запрошено",
  resolved: "Закрыта",
  rejected: "Отклонена",
};

export function labelFrankingCategory(category: FrankingReportCategory): string {
  return CATEGORY_LABELS[category];
}

/** Civic surface the report belongs to. Franking is messages-only for now. */
export function labelFrankingArea(): string {
  return "Сообщения";
}

export function labelFrankingStatus(status: FrankingReportStatus): string {
  return STATUS_LABELS[status];
}

export function labelFrankingVerification(status: FrankingVerificationStatus): string {
  return VERIFICATION_LABELS[status];
}

export function labelFrankingAuditEvent(event: FrankingAuditEvent): string {
  return AUDIT_EVENT_LABELS[event];
}

export function labelHasDisclosure(hasDisclosure: boolean): string {
  return hasDisclosure ? "Есть" : "Нет";
}
