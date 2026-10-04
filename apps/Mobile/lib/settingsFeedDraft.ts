import type {
  FeedAuthorDiversity,
  FeedExploration,
  FeedFreshness,
  FeedSeenPostsMode,
} from "@flora/client-core/contracts";

export {
  defaultFeedDraft,
  feedDraftEqual,
  feedDraftFromApi,
  feedDraftFromDto,
  type SettingsFeedDraft,
} from "@flora/client-core/contracts";

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
