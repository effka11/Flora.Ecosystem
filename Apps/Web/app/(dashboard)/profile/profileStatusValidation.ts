import styles from "./profile.module.css";

/** Как в 2142-1 / PATCH /api/auth/profile. */
export const PROFILE_STATUS_MAX_LENGTH = 150;

const PROFILE_STATUS_THREE_LINES_ERROR =
  "Статус не должен занимать больше 3 строк. Сократите текст или измените переносы.";

/**
 * Проверка из 2142-1 (`__floraStatusFitsThreeLines`): те же классы, что на карточке профиля.
 */
export function profileStatusFitsThreeLines(text: string, contentWidthPx?: number): boolean {
  if (!text.trim()) return true;
  if (typeof document === "undefined") return true;

  const width =
    contentWidthPx ??
    document.querySelector<HTMLElement>("[data-profile-status-measure]")?.clientWidth ??
    Math.round(54 * 15);

  const wrapper = document.createElement("div");
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.style.cssText = `position:absolute;left:-9999px;top:0;width:${width}px;overflow:hidden;visibility:hidden;pointer-events:none`;

  const top = document.createElement("div");
  top.className = styles.profileInfoTop;

  const status = document.createElement("p");
  status.className = styles.profileStatus;

  const span = document.createElement("span");
  span.className = styles.profileStatusText;
  span.textContent = text;

  status.appendChild(span);
  top.appendChild(status);
  wrapper.appendChild(top);
  document.body.appendChild(wrapper);

  const lineHeight = Number.parseFloat(getComputedStyle(status).lineHeight) || 20;
  const height = status.offsetHeight;
  document.body.removeChild(wrapper);

  return height <= lineHeight * 3 + 2;
}

export function validateProfileStatus(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length > PROFILE_STATUS_MAX_LENGTH) {
    return `Статус не более ${PROFILE_STATUS_MAX_LENGTH} символов.`;
  }
  if (trimmed.length > 0 && !profileStatusFitsThreeLines(trimmed)) {
    return PROFILE_STATUS_THREE_LINES_ERROR;
  }
  return null;
}

export function normalizeProfileStatusForApi(text: string): string {
  return text.trim();
}
