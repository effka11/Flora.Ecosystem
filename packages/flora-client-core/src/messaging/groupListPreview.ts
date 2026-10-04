const LIST_PREVIEW_MAX_LEN = 80;
const DECRYPT_FAIL_LABEL = "[ не удалось расшифровать ]";
/** UI fallback when peer display name is unknown — not a username. */
export const GROUP_LIST_UNKNOWN_SENDER_LABEL = "Участник";

export type FormatGroupListPreviewArgs = {
  preview: string;
  isFromMe: boolean;
  /** Display name only — never username/nickname. */
  senderDisplayName?: string | null;
};

/**
 * Group row preview in chat list: `Вы: …` / `{displayName}: …` / `Участник: …`.
 * Peer rows always get a source prefix when there is a message body.
 */
export function formatGroupListPreview({
  preview,
  isFromMe,
  senderDisplayName,
}: FormatGroupListPreviewArgs): string {
  const body = preview.trim();
  if (body === "Расшифровка…") return body;
  if (!body || body === "…") return "Нет сообщений";
  const truncated =
    body.length > LIST_PREVIEW_MAX_LEN ? `${body.slice(0, LIST_PREVIEW_MAX_LEN)}…` : body;
  const normalized = truncated === "🔒" ? DECRYPT_FAIL_LABEL : truncated;
  if (isFromMe) return `Вы: ${normalized}`;
  const name = senderDisplayName?.trim() || GROUP_LIST_UNKNOWN_SENDER_LABEL;
  return `${name}: ${normalized}`;
}
