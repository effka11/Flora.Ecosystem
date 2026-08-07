import {
  accountDraftEqual,
  accountDraftFromMe as accountDraftFromMeCore,
  defaultPrivacyDraft as defaultPrivacyDraftCore,
  privacyDraftEqual as privacyDraftEqualCore,
  privacyDraftFromApi as privacyDraftFromApiCore,
  privacyDraftToApiPayload as privacyDraftToApiPayloadCore,
  validateAccountDraft,
  type MessagesFrom,
  type OnlineVisibility,
  type PrivacyVisibility,
  type SettingsAccountDraft,
  type SettingsPrivacyDraft,
} from "@flora/client-core/auth";
import {
  defaultFeedDraft as defaultFeedDraftCore,
  feedDraftEqual as feedDraftEqualCore,
  feedDraftFromApi as feedDraftFromApiCore,
  type FeedAuthorDiversity,
  type FeedExploration,
  type FeedFreshness,
  type FeedSeenPostsMode,
  type SettingsFeedDraft,
} from "@flora/client-core/contracts";
import {
  normalizeProfileStatusForApi,
  validateProfileStatus,
} from "@/app/(dashboard)/profile/profileStatusValidation";
import { isReservedUsername, RESERVED_USERNAME_MESSAGE } from "@/lib/reservedUsernames";

const LOCAL_PREFS_STORAGE_KEY = "flora.userSettings.prefs";

export type { FeedAuthorDiversity, FeedExploration, FeedFreshness, FeedSeenPostsMode };
export type { MessagesFrom, OnlineVisibility, PrivacyVisibility };

export type UserSettingsAccountDraft = SettingsAccountDraft;

export type UserSettingsPrivacyDraft = SettingsPrivacyDraft;

export type UserSettingsFeedDraft = SettingsFeedDraft;

export type UserSettingsNotificationsDraft = {
  pushEnabled: boolean;
  emailEnabled: boolean;
  quietMode: boolean;
  quietFrom: string;
  quietTo: string;
  quietAllowImportant: boolean;
};

export type UserSettingsCustomizationDraft = {
  theme: "system" | "dark" | "light" | "midnight";
  animSpeed: "smooth" | "fast" | "reduced";
  enableAnimations: boolean;
  enableBlur: boolean;
};

export type UserSettingsLocalPrefs = {
  notifications: UserSettingsNotificationsDraft;
  customization: UserSettingsCustomizationDraft;
};

export type UserSettingsDraft = UserSettingsLocalPrefs & {
  account: UserSettingsAccountDraft;
  privacy: UserSettingsPrivacyDraft;
  feed: UserSettingsFeedDraft;
};

const DEFAULT_NOTIFICATIONS: UserSettingsNotificationsDraft = {
  pushEnabled: true,
  emailEnabled: true,
  quietMode: false,
  quietFrom: "23:00",
  quietTo: "08:00",
  quietAllowImportant: true,
};

const DEFAULT_CUSTOMIZATION: UserSettingsCustomizationDraft = {
  theme: "dark",
  animSpeed: "smooth",
  enableAnimations: true,
  enableBlur: true,
};

export function defaultPrivacyDraft(): UserSettingsPrivacyDraft {
  return defaultPrivacyDraftCore();
}

export function defaultFeedDraft(): UserSettingsFeedDraft {
  return defaultFeedDraftCore();
}

export function defaultUserSettingsLocalPrefs(): UserSettingsLocalPrefs {
  return {
    notifications: { ...DEFAULT_NOTIFICATIONS },
    customization: { ...DEFAULT_CUSTOMIZATION },
  };
}

export function privacyDraftFromApi(raw: unknown): UserSettingsPrivacyDraft {
  return privacyDraftFromApiCore(raw);
}

export function privacyDraftToApiPayload(draft: UserSettingsPrivacyDraft): UserSettingsPrivacyDraft {
  return privacyDraftToApiPayloadCore(draft);
}

export function privacyDraftEqual(a: UserSettingsPrivacyDraft, b: UserSettingsPrivacyDraft): boolean {
  return privacyDraftEqualCore(a, b);
}

export function feedDraftFromApi(raw: unknown): UserSettingsFeedDraft {
  return feedDraftFromApiCore(raw);
}

export function feedDraftEqual(a: UserSettingsFeedDraft, b: UserSettingsFeedDraft): boolean {
  return feedDraftEqualCore(a, b);
}

export function accountDraftFromMe(me: {
  displayName: string;
  username: string;
  status?: string;
  birthDate?: string;
}): UserSettingsAccountDraft {
  return accountDraftFromMeCore(me);
}

export function loadUserSettingsLocalPrefs(): UserSettingsLocalPrefs {
  if (typeof window === "undefined") return defaultUserSettingsLocalPrefs();
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFS_STORAGE_KEY);
    if (!raw) return defaultUserSettingsLocalPrefs();
    const parsed = JSON.parse(raw) as Partial<UserSettingsLocalPrefs>;
    return {
      notifications: { ...DEFAULT_NOTIFICATIONS, ...parsed.notifications },
      customization: { ...DEFAULT_CUSTOMIZATION, ...parsed.customization },
    };
  } catch {
    return defaultUserSettingsLocalPrefs();
  }
}

export function saveUserSettingsLocalPrefs(prefs: UserSettingsLocalPrefs): void {
  try {
    window.localStorage.setItem(LOCAL_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function userSettingsDraftFromSources(
  me: {
    displayName: string;
    username: string;
    status?: string;
    birthDate?: string;
  },
  localPrefs: UserSettingsLocalPrefs,
  privacy: UserSettingsPrivacyDraft = defaultPrivacyDraft(),
  feed: UserSettingsFeedDraft = defaultFeedDraft(),
): UserSettingsDraft {
  return {
    account: accountDraftFromMe(me),
    privacy,
    feed,
    ...localPrefs,
  };
}

export function accountDraftHasChanges(
  draft: UserSettingsAccountDraft,
  me: {
    displayName: string;
    username: string;
    status?: string;
    birthDate?: string;
  },
): boolean {
  const saved = accountDraftFromMe(me);
  return !accountDraftEqual(
    {
      displayName: draft.displayName,
      username: draft.username,
      birthDate: draft.birthDate,
      status: normalizeProfileStatusForApi(draft.status),
    },
    {
      displayName: saved.displayName,
      username: saved.username,
      birthDate: saved.birthDate,
      status: normalizeProfileStatusForApi(saved.status),
    },
  );
}

function localPrefsEqual(a: UserSettingsLocalPrefs, b: UserSettingsLocalPrefs): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function userSettingsDraftHasChanges(
  draft: UserSettingsDraft,
  me: {
    displayName: string;
    username: string;
    status?: string;
    birthDate?: string;
  },
  savedLocalPrefs: UserSettingsLocalPrefs,
  savedPrivacy: UserSettingsPrivacyDraft,
  savedFeed: UserSettingsFeedDraft,
): boolean {
  return (
    accountDraftHasChanges(draft.account, me) ||
    !privacyDraftEqual(draft.privacy, savedPrivacy) ||
    !feedDraftEqual(draft.feed, savedFeed) ||
    !localPrefsEqual(
      { notifications: draft.notifications, customization: draft.customization },
      savedLocalPrefs,
    )
  );
}

export function validateUserSettingsAccountDraft(draft: UserSettingsAccountDraft): string | null {
  const base = validateAccountDraft({ ...draft, status: "" });
  if (base) return base;
  const nick = draft.username.trim().replace(/^@+/, "").toLowerCase();
  if (isReservedUsername(nick)) return RESERVED_USERNAME_MESSAGE;
  return validateProfileStatus(normalizeProfileStatusForApi(draft.status));
}

export function userSettingsAccountToApiPayload(draft: UserSettingsAccountDraft) {
  return {
    displayName: draft.displayName.trim(),
    username: draft.username.trim().replace(/^@+/, "").toLowerCase(),
    status: normalizeProfileStatusForApi(draft.status),
    birthDate: draft.birthDate.trim() ? draft.birthDate.trim() : "",
  };
}

export function userSettingsDraftToLocalPrefs(draft: UserSettingsDraft): UserSettingsLocalPrefs {
  return {
    notifications: draft.notifications,
    customization: draft.customization,
  };
}
