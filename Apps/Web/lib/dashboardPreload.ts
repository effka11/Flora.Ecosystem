import { apiGetMe, apiGetPrivacySettings, avatarImageUrl, isDevLocalOfflineSession } from "@/lib/auth";
import { preloadConversationThreads } from "@/lib/conversationThreadsCache";
import { msgGetConversations, type MsgConversationsPage } from "@/lib/messagingApi";
import {
  apiGetMusicLibrary,
  apiGetMusicPlaylists,
  type MusicPlaylistSummaryDto,
  type MusicTrackDto,
} from "@/lib/musicApi";
import { apiListNotifications, type NotificationDto } from "@/lib/notificationsApi";
import {
  apiGetFeed,
  apiGetProfileFollowers,
  apiGetProfileFollowing,
  apiGetProfilePosts,
  apiGetPublicProfile,
  apiGetRecommendedCommunities,
  apiGetRecommendedUsers,
  apiListOwnedCommunities,
  apiListProfileCommunities,
  apiListPublicCommunities,
  type FeedKind,
  type FeedPageDto,
  type OwnedCommunityDto,
  type PeopleListEntryDto,
  type ProfileCommunityDto,
  type ProfilePostDto,
  type PublicProfileDto,
  type RecommendedUserDto,
} from "@/lib/socialApi";

const DEFAULT_TTL_MS = 60_000;
/** Пауза между задачами внутри фоновой волны (некритичные вкладки). */
const PREFETCH_WAVE_DELAY_MS = 250;
/** Старт фоновых волн после критического prefetch (feed/messages/notifications уже без задержки). */
const PREFETCH_BACKGROUND_START_MS = 400;
const IMAGE_WARMUP_LIMIT = 12;
/** Сколько верхних диалогов прогревать до открытия Messages. */
export const TOP_THREAD_PRELOAD_COUNT = 4;

type CacheEntry<T> = {
  value: T;
  fetchedAt: number;
};

export type CachedResource<T> = {
  prefetch: () => void;
  peek: () => T | null;
  get: () => Promise<T>;
  set: (value: T) => void;
  invalidate: () => void;
};

function createCachedResource<T>(fetcher: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): CachedResource<T> {
  let entry: CacheEntry<T> | null = null;
  let inFlight: Promise<T> | null = null;

  const fetchFresh = (): Promise<T> => {
    if (inFlight) return inFlight;
    inFlight = fetcher()
      .then((value) => {
        entry = { value, fetchedAt: Date.now() };
        inFlight = null;
        return value;
      })
      .catch((error) => {
        inFlight = null;
        throw error;
      });
    return inFlight;
  };

  const isFresh = (): boolean => Boolean(entry && Date.now() - entry.fetchedAt < ttlMs);

  return {
    prefetch() {
      if (isFresh()) return;
      void fetchFresh().catch(() => {});
    },
    peek() {
      return entry?.value ?? null;
    },
    get() {
      if (isFresh() && entry) {
        return Promise.resolve(entry.value);
      }
      return fetchFresh();
    },
    set(value) {
      entry = { value, fetchedAt: Date.now() };
    },
    invalidate() {
      entry = null;
      inFlight = null;
    },
  };
}

function createKeyedCachedResource<K, T>(
  fetcher: (key: K) => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): {
  prefetch: (key: K) => void;
  peek: (key: K) => T | null;
  get: (key: K) => Promise<T>;
  set: (key: K, value: T) => void;
  invalidate: (key?: K) => void;
} {
  const entries = new Map<K, CacheEntry<T>>();
  const inFlights = new Map<K, Promise<T>>();

  const fetchFresh = (key: K): Promise<T> => {
    const existing = inFlights.get(key);
    if (existing) return existing;

    const promise = fetcher(key)
      .then((value) => {
        entries.set(key, { value, fetchedAt: Date.now() });
        inFlights.delete(key);
        return value;
      })
      .catch((error) => {
        inFlights.delete(key);
        throw error;
      });
    inFlights.set(key, promise);
    return promise;
  };

  const isFresh = (key: K): boolean => {
    const entry = entries.get(key);
    return Boolean(entry && Date.now() - entry.fetchedAt < ttlMs);
  };

  return {
    prefetch(key) {
      if (isFresh(key)) return;
      void fetchFresh(key).catch(() => {});
    },
    peek(key) {
      return entries.get(key)?.value ?? null;
    },
    get(key) {
      const entry = entries.get(key);
      if (entry && isFresh(key)) {
        return Promise.resolve(entry.value);
      }
      return fetchFresh(key);
    },
    set(key, value) {
      entries.set(key, { value, fetchedAt: Date.now() });
    },
    invalidate(key) {
      if (key === undefined) {
        entries.clear();
        inFlights.clear();
        return;
      }
      entries.delete(key);
      inFlights.delete(key);
    },
  };
}

export type CommunitiesPreloadBundle = {
  ownedList: OwnedCommunityDto[];
  meUsername: string | null;
  recommendedList: OwnedCommunityDto[];
  publicList: OwnedCommunityDto[];
  subscribedList: ProfileCommunityDto[];
};

export type ProfilePreloadBundle = {
  publicProfile: PublicProfileDto;
  posts: ProfilePostDto[];
};

async function fetchCommunitiesBundle(): Promise<CommunitiesPreloadBundle> {
  const [ownedList, me] = await Promise.all([apiListOwnedCommunities(), apiGetMe().catch(() => null)]);

  if (isDevLocalOfflineSession()) {
    return {
      ownedList,
      meUsername: me?.username ?? null,
      recommendedList: [],
      publicList: [],
      subscribedList: [],
    };
  }

  const [recommendedList, publicList] = await Promise.all([
    apiGetRecommendedCommunities(),
    apiListPublicCommunities(),
  ]);
  const subscribedList = me?.username
    ? await apiListProfileCommunities(me.username).catch(() => [])
    : [];

  return {
    ownedList,
    meUsername: me?.username ?? null,
    recommendedList,
    publicList,
    subscribedList,
  };
}

export const feedRecommendationsCache = createCachedResource(() => apiGetFeed(30, null, "recommendations"));
export const feedSubscriptionsCache = createCachedResource(() => apiGetFeed(30, null, "subscriptions"));
export const conversationsCache = createCachedResource(() => msgGetConversations());
export const peopleRecommendedCache = createCachedResource(() => apiGetRecommendedUsers(40));
export const peopleFollowersCache = createKeyedCachedResource((username: string) =>
  apiGetProfileFollowers(username, 0, 50),
);
export const peopleFollowingCache = createKeyedCachedResource((username: string) =>
  apiGetProfileFollowing(username, 0, 50),
);
export const communitiesBundleCache = createCachedResource(fetchCommunitiesBundle);
export const musicLibraryCache = createCachedResource(() => apiGetMusicLibrary());
export const musicPlaylistsCache = createCachedResource(() => apiGetMusicPlaylists());
export const notificationsAllCache = createCachedResource(() =>
  apiListNotifications({ category: "all", take: 100 }),
);
export const profileBundleCache = createKeyedCachedResource(async (username: string): Promise<ProfilePreloadBundle> => {
  const [publicProfile, posts] = await Promise.all([
    apiGetPublicProfile(username),
    apiGetProfilePosts(username, 0, 30),
  ]);
  return { publicProfile, posts };
});
export const privacySettingsCache = createCachedResource(() => apiGetPrivacySettings());

export function feedCacheForKind(kind: FeedKind): CachedResource<FeedPageDto> {
  return kind === "subscriptions" ? feedSubscriptionsCache : feedRecommendationsCache;
}

export function invalidateFeedCaches(): void {
  feedRecommendationsCache.invalidate();
  feedSubscriptionsCache.invalidate();
}

export function invalidateProfileCache(username?: string): void {
  if (username) {
    profileBundleCache.invalidate(username);
    return;
  }
  profileBundleCache.invalidate();
}

export function invalidateMusicCaches(): void {
  musicLibraryCache.invalidate();
  musicPlaylistsCache.invalidate();
}

export function invalidatePeopleCaches(username?: string): void {
  peopleRecommendedCache.invalidate();
  if (username) {
    peopleFollowersCache.invalidate(username);
    peopleFollowingCache.invalidate(username);
    return;
  }
  peopleFollowersCache.invalidate();
  peopleFollowingCache.invalidate();
}

export function invalidateNotificationsCache(): void {
  notificationsAllCache.invalidate();
}

function normalizeUsernameKey(username: string): string {
  return username.trim().replace(/^@+/, "");
}

function collectAvatarWarmupUrls(): string[] {
  const urls = new Set<string>();

  const conversations = conversationsCache.peek();
  if (conversations) {
    for (const item of conversations.items) {
      const avatarUuid = item.otherAvatarUuid?.trim();
      if (avatarUuid) urls.add(avatarImageUrl(avatarUuid));
      if (urls.size >= IMAGE_WARMUP_LIMIT) break;
    }
  }

  return [...urls].slice(0, IMAGE_WARMUP_LIMIT);
}

export function warmupDashboardAvatarImages(): void {
  if (typeof window === "undefined") return;
  for (const url of collectAvatarWarmupUrls()) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
  }
}

function scheduleIdleTask(task: () => void, delayMs = 0): void {
  if (typeof window === "undefined") return;
  const run = () => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => task(), { timeout: 2_000 });
      return;
    }
    task();
  };
  if (delayMs <= 0) {
    run();
    return;
  }
  window.setTimeout(run, delayMs);
}

function runPrefetchWave(tasks: Array<() => void>, startDelayMs: number): void {
  tasks.forEach((task, index) => {
    scheduleIdleTask(task, startDelayMs + index * PREFETCH_WAVE_DELAY_MS);
  });
}

function preloadMessageEmojiPickerChunk(): void {
  void import("@/app/(dashboard)/messages/MessageEmojiPicker")
    .then((mod) => mod.preloadMessageEmojiPicker())
    .catch(() => {});
}

/** Dedupe фоновых волн + pending thread prefetch до появления viewerUuid. */
let backgroundPrefetchUserKey: string | null = null;
let pendingThreadPrefetch: Promise<MsgConversationsPage | null> | null = null;
let pendingThreadViewerNorm = "";
let lastThreadPrefetchSignature = "";

function runTopThreadPrefetch(viewerNorm: string, page: MsgConversationsPage): void {
  const peerUuids = page.items
    .slice(0, TOP_THREAD_PRELOAD_COUNT)
    .map((item) => item.otherUserUuid)
    .filter(Boolean);
  if (peerUuids.length === 0) return;
  const signature = `${viewerNorm}|${peerUuids.join(",")}`;
  if (lastThreadPrefetchSignature === signature) return;
  lastThreadPrefetchSignature = signature;
  preloadConversationThreads(viewerNorm, peerUuids);
}

/**
 * После списка чатов — прогреть верхние треды.
 * Без viewerUuid только держит список в pending; треды стартуют через attachPendingThreadPrefetchViewer.
 */
function prefetchTopConversationThreads(viewerUuid?: string | null): void {
  const viewerNorm = viewerUuid?.trim().toLowerCase() ?? pendingThreadViewerNorm;

  const finish = (page: MsgConversationsPage | null) => {
    if (!page?.items.length) return;
    if (!viewerNorm) {
      pendingThreadPrefetch = Promise.resolve(page);
      return;
    }
    pendingThreadPrefetch = null;
    runTopThreadPrefetch(viewerNorm, page);
  };

  const cached = conversationsCache.peek();
  if (cached) {
    finish(cached);
    return;
  }

  if (!pendingThreadPrefetch) {
    pendingThreadPrefetch = conversationsCache.get().catch(() => null);
  }
  void pendingThreadPrefetch.then(finish);
}

/** Когда apiGetMe вернул uuid — догрузить треды, если список уже прогрет без viewer. */
export function attachPendingThreadPrefetchViewer(viewerUuid: string): void {
  const viewerNorm = viewerUuid.trim().toLowerCase();
  if (!viewerNorm) return;
  pendingThreadViewerNorm = viewerNorm;
  prefetchTopConversationThreads(viewerNorm);
}

/** Сброс dedupe фоновых волн / pending thread prefetch (logout / смена сессии). */
export function resetDashboardPrefetchState(): void {
  backgroundPrefetchUserKey = null;
  pendingThreadPrefetch = null;
  pendingThreadViewerNorm = "";
  lastThreadPrefetchSignature = "";
}

/** Ранний prefetch вкладки «Сообщения» (наведение / pointerdown в сайдбаре). */
export function startMessagesTabPrefetch(viewerUuid?: string | null): void {
  if (typeof window === "undefined") return;
  conversationsCache.prefetch();
  preloadMessageEmojiPickerChunk();
  prefetchTopConversationThreads(viewerUuid);
}

/** Prefetch данных вкладки по href сайдбара (hover / pointerdown до перехода). */
export function startTabPrefetch(href: string, options?: { username?: string | null; viewerUuid?: string | null }): void {
  if (typeof window === "undefined") return;
  const path = href.split("?")[0]?.split("#")[0] ?? href;
  const username = options?.username ? normalizeUsernameKey(options.username) : "";

  if (path === "/messages" || path.startsWith("/messages/")) {
    startMessagesTabPrefetch(options?.viewerUuid);
    return;
  }
  if (path === "/feed" || path.startsWith("/feed/")) {
    feedRecommendationsCache.prefetch();
    feedSubscriptionsCache.prefetch();
    return;
  }
  if (path === "/notifications" || path.startsWith("/notifications/")) {
    notificationsAllCache.prefetch();
    return;
  }
  if (path === "/people" || path.startsWith("/people/")) {
    peopleRecommendedCache.prefetch();
    if (username) {
      peopleFollowersCache.prefetch(username);
      peopleFollowingCache.prefetch(username);
    }
    return;
  }
  if (path === "/communities" || path.startsWith("/communities/")) {
    communitiesBundleCache.prefetch();
    return;
  }
  if (path === "/music" || path.startsWith("/music/")) {
    musicLibraryCache.prefetch();
    musicPlaylistsCache.prefetch();
    return;
  }
  if (path === "/settings" || path.startsWith("/settings/")) {
    privacySettingsCache.prefetch();
    return;
  }
  if (path === "/profile" || path.startsWith("/profile/")) {
    if (username) profileBundleCache.prefetch(username);
  }
}

/**
 * Тихая фоновая предзагрузка данных всех вкладок после входа в дашборд.
 * Критичные вкладки (лента / сообщения / уведомления) стартуют сразу;
 * остальное — короткими idle-волнами, чтобы не конкурировать с первым экраном.
 */

/** Критический prefetch без ожидания профиля — можно вызывать сразу при наличии токена. */
export function startCriticalDashboardPrefetch(): void {
  if (typeof window === "undefined") return;
  feedRecommendationsCache.prefetch();
  feedSubscriptionsCache.prefetch();
  conversationsCache.prefetch();
  notificationsAllCache.prefetch();
  preloadMessageEmojiPickerChunk();
  // Список чатов → pending треды; сами треды стартуют после attachPendingThreadPrefetchViewer.
  prefetchTopConversationThreads();
}

export function startDashboardDataPrefetch(username?: string | null, viewerUuid?: string | null): void {
  if (typeof window === "undefined") return;

  const normalizedUsername = username ? normalizeUsernameKey(username) : "";
  const viewerNorm = viewerUuid?.trim().toLowerCase() ?? "";

  startCriticalDashboardPrefetch();
  if (viewerNorm) {
    attachPendingThreadPrefetchViewer(viewerNorm);
  }

  const userKey = viewerNorm || normalizedUsername || "_";
  if (backgroundPrefetchUserKey === userKey) return;
  backgroundPrefetchUserKey = userKey;

  runPrefetchWave(
    [
      () => peopleRecommendedCache.prefetch(),
      () => communitiesBundleCache.prefetch(),
      () => musicLibraryCache.prefetch(),
      () => musicPlaylistsCache.prefetch(),
    ],
    PREFETCH_BACKGROUND_START_MS,
  );

  runPrefetchWave(
    [
      () => privacySettingsCache.prefetch(),
      () => {
        if (normalizedUsername) {
          profileBundleCache.prefetch(normalizedUsername);
          peopleFollowersCache.prefetch(normalizedUsername);
          peopleFollowingCache.prefetch(normalizedUsername);
        }
      },
      () => {
        void Promise.all([
          conversationsCache.get().catch(() => null),
          peopleRecommendedCache.get().catch(() => null),
        ]).finally(() => warmupDashboardAvatarImages());
      },
    ],
    PREFETCH_BACKGROUND_START_MS + PREFETCH_WAVE_DELAY_MS * 4,
  );
}

export type { FeedPageDto, MsgConversationsPage, NotificationDto, MusicTrackDto, MusicPlaylistSummaryDto };
export type { RecommendedUserDto, PeopleListEntryDto };
