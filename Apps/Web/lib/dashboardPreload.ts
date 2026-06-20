import { apiGetMe, apiGetPrivacySettings, avatarImageUrl, isDevLocalOfflineSession } from "@/lib/auth";
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
const PREFETCH_WAVE_DELAY_MS = 300;
const PREFETCH_START_DELAY_MS = 1_000;
const IMAGE_WARMUP_LIMIT = 12;

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

  return {
    prefetch() {
      void fetchFresh().catch(() => {});
    },
    peek() {
      return entry?.value ?? null;
    },
    get() {
      if (entry && Date.now() - entry.fetchedAt < ttlMs) {
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

  return {
    prefetch(key) {
      void fetchFresh(key).catch(() => {});
    },
    peek(key) {
      return entries.get(key)?.value ?? null;
    },
    get(key) {
      const entry = entries.get(key);
      if (entry && Date.now() - entry.fetchedAt < ttlMs) {
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
      window.requestIdleCallback(() => task(), { timeout: 4_000 });
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

/** Ранний prefetch вкладки «Сообщения» (наведение / pointerdown в сайдбаре). */
export function startMessagesTabPrefetch(): void {
  if (typeof window === "undefined") return;
  conversationsCache.prefetch();
  void import("@/app/(dashboard)/messages/MessageEmojiPicker")
    .then((mod) => mod.preloadMessageEmojiPicker())
    .catch(() => {});
}

/** Тихая фоновая предзагрузка данных всех вкладок после входа в дашборд. */
export function startDashboardDataPrefetch(username?: string | null): void {
  if (typeof window === "undefined") return;

  const normalizedUsername = username ? normalizeUsernameKey(username) : "";

  runPrefetchWave(
    [
      () => conversationsCache.prefetch(),
      () => notificationsAllCache.prefetch(),
      () => {
        void import("@/app/(dashboard)/messages/MessageEmojiPicker")
          .then((mod) => mod.preloadMessageEmojiPicker())
          .catch(() => {});
      },
    ],
    PREFETCH_START_DELAY_MS,
  );

  runPrefetchWave(
    [
      () => feedRecommendationsCache.prefetch(),
      () => feedSubscriptionsCache.prefetch(),
      () => peopleRecommendedCache.prefetch(),
    ],
    PREFETCH_START_DELAY_MS + PREFETCH_WAVE_DELAY_MS * 3,
  );

  runPrefetchWave(
    [
      () => communitiesBundleCache.prefetch(),
      () => musicLibraryCache.prefetch(),
      () => musicPlaylistsCache.prefetch(),
    ],
    PREFETCH_START_DELAY_MS + PREFETCH_WAVE_DELAY_MS * 6,
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
    PREFETCH_START_DELAY_MS + PREFETCH_WAVE_DELAY_MS * 9,
  );
}

export type { FeedPageDto, MsgConversationsPage, NotificationDto, MusicTrackDto, MusicPlaylistSummaryDto };
export type { RecommendedUserDto, PeopleListEntryDto };
