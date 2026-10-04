import type {
  FrankingReportCategory,
  FrankingReportStatus,
  FrankingReviewedBlock,
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

export function labelHasDisclosure(hasDisclosure: boolean): string {
  return hasDisclosure ? "Есть" : "Нет";
}

export function labelFrankingReviewedBlock(block: FrankingReviewedBlock): string {
  switch (block.kind) {
    case "text":
      return block.body;
    case "voice":
      return "Голос";
    case "image":
      return "Фото";
    case "video":
      return "Видео";
    case "unknown":
      return block.originalKind;
  }
}
