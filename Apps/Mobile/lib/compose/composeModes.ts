import {
  MAX_POST_CONTENT_LENGTH,
  MAX_POST_IMAGE_BYTES,
  MAX_POST_IMAGES,
  MAX_POST_VIDEO_BYTES,
  clampPostContent,
} from "@flora/client-core/api";

export {
  MAX_POST_CONTENT_LENGTH,
  MAX_POST_IMAGE_BYTES,
  MAX_POST_IMAGES,
  MAX_POST_VIDEO_BYTES,
  clampPostContent,
};

export const COMPOSE_PROFILE_MODE_ID = "primary";
export const COMPOSE_COMMUNITY_MODE_PREFIX = "community:";

export function composeCommunityModeId(communityId: string): string {
  return `${COMPOSE_COMMUNITY_MODE_PREFIX}${communityId}`;
}

export function isComposeCommunityModeId(modeId: string): boolean {
  return modeId.startsWith(COMPOSE_COMMUNITY_MODE_PREFIX);
}

export function composeModeCommunityId(modeId: string): string | undefined {
  if (!isComposeCommunityModeId(modeId)) return undefined;
  const id = modeId.slice(COMPOSE_COMMUNITY_MODE_PREFIX.length).trim();
  return id || undefined;
}

export const COMPOSE_BODY_PLACEHOLDERS: readonly string[] = [
  "За окном пошел дождь...",
  "Вчера в Краснодарском крае...",
  "С точки зрения автора книги...",
  "Интернет охватило новое слово...",
  "Рынок акций растет в сфере...",
  "В России запретили...",
  "Казалось бы...",
  "Уже в который раз...",
  "Ни оконцев ни дверцов...",
  "По поводу...",
  "Смех смехом, а...",
  "Видели ли вы...",
  "Только что прочитал...",
  "Замечали ли вы...",
  "Бывали случаи когда...",
  "По статистике...",
  "Выходит что...",
  "Волонтеры помогли...",
  "Оцените мой...",
];

export function pickRandomComposeBodyPlaceholder(): string {
  if (COMPOSE_BODY_PLACEHOLDERS.length === 0) return "";
  const i = Math.floor(Math.random() * COMPOSE_BODY_PLACEHOLDERS.length);
  return COMPOSE_BODY_PLACEHOLDERS[i] ?? "";
}
