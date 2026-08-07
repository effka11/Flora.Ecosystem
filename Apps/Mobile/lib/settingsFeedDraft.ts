import type {
  FeedAuthorDiversity,
  FeedExploration,
  FeedFreshness,
  FeedSeenPostsMode,
  FeedSettingsDto,
} from "@flora/client-core/contracts";

export type SettingsFeedDraft = {
  freshness: FeedFreshness;
  exploration: FeedExploration;
  showReposts: boolean;
  communityPosts: boolean;
  seenPosts: FeedSeenPostsMode;
  authorDiversity: FeedAuthorDiversity;
};

/** Дефолты продакшена (FIRA-F §User Controls): Balanced/Standard + демоция просмотренных. */
const DEFAULT_FEED: SettingsFeedDraft = {
  freshness: "balanced",
  exploration: "standard",
  showReposts: true,
  communityPosts: true,
  seenPosts: "demote",
  authorDiversity: "standard",
};

export function defaultFeedDraft(): SettingsFeedDraft {
  return { ...DEFAULT_FEED };
}

function parseFeedEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

export function feedDraftFromApi(raw: FeedSettingsDto | unknown): SettingsFeedDraft {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    freshness: parseFeedEnum(source.freshness, ["fresh", "balanced", "popular"], DEFAULT_FEED.freshness),
    exploration: parseFeedEnum(
      source.exploration,
      ["off", "low", "standard", "high"],
      DEFAULT_FEED.exploration,
    ),
    showReposts:
      typeof source.showReposts === "boolean" ? source.showReposts : DEFAULT_FEED.showReposts,
    communityPosts:
      typeof source.communityPosts === "boolean"
        ? source.communityPosts
        : DEFAULT_FEED.communityPosts,
    seenPosts: parseFeedEnum(source.seenPosts, ["show", "demote", "hide"], DEFAULT_FEED.seenPosts),
    authorDiversity: parseFeedEnum(
      source.authorDiversity,
      ["strict", "standard", "off"],
      DEFAULT_FEED.authorDiversity,
    ),
  };
}

export function feedDraftEqual(a: SettingsFeedDraft, b: SettingsFeedDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const FEED_FRESHNESS_OPTIONS: readonly { value: FeedFreshness; label: string }[] = [
  { value: "fresh", label: "Свежее — приоритет новым постам" },
  { value: "balanced", label: "Сбалансированно" },
  { value: "popular", label: "Популярное — лучшие за неделю" },
] as const;

export const FEED_EXPLORATION_OPTIONS: readonly { value: FeedExploration; label: string }[] = [
  { value: "off", label: "Выкл — только знакомые темы" },
  { value: "low", label: "Меньше нового" },
  { value: "standard", label: "Стандартно" },
  { value: "high", label: "Больше нового" },
] as const;

export const FEED_AUTHOR_DIVERSITY_OPTIONS: readonly {
  value: FeedAuthorDiversity;
  label: string;
}[] = [
  { value: "strict", label: "Строгое — не чаще 1 поста подряд" },
  { value: "standard", label: "Стандартное — до 2 постов подряд" },
  { value: "off", label: "Выкл — как ранжирует алгоритм" },
] as const;

export const FEED_SEEN_POSTS_OPTIONS: readonly { value: FeedSeenPostsMode; label: string }[] = [
  { value: "show", label: "Показывать как обычно" },
  { value: "demote", label: "Показывать реже" },
  { value: "hide", label: "Скрывать" },
] as const;
