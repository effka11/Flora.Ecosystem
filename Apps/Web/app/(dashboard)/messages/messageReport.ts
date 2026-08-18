import type { FrankingReportCategory } from "@flora/client-core/contracts";

export const FRANKING_REPORT_CATEGORY_OPTIONS: ReadonlyArray<{
  value: FrankingReportCategory;
  label: string;
}> = [
  { value: "abuse", label: "Злоупотребление" },
  { value: "threats", label: "Угрозы" },
  { value: "spam", label: "Спам" },
  { value: "csam", label: "Эксплуатация несовершеннолетних" },
  { value: "other", label: "Другое" },
];

export function canReportMessage(input: {
  isFromMe: boolean;
  isGroupChat: boolean;
  sendStatus?: string;
}): boolean {
  if (input.isFromMe) return false;
  if (input.isGroupChat) return false;
  if (input.sendStatus === "sending") return false;
  return true;
}
