import { isReservedUsername, RESERVED_USERNAME_MESSAGE } from "@/lib/reservedUsernames";
import {
  normalizeProfileStatusForApi,
  validateProfileStatus,
} from "@/app/(dashboard)/profile/profileStatusValidation";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,50}$/;
const LOCAL_PREFS_STORAGE_KEY = "flora.userSettings.prefs";

export type PrivacyVisibility = "all" | "friends" | "none";
export type OnlineVisibility = "visible" | "hidden";
export type MessagesFrom = "all" | "friends";

export type UserSettingsAccountDraft = {
  displayName: string;
  username: string;
  birthDate: string;
  status: string;
};

export type UserSettingsPrivacyDraft = {
  friendsVisibility: PrivacyVisibility;
  subscriptionsVisibility: PrivacyVisibility;
  postsVisibility: PrivacyVisibility;
  likesVisibility: PrivacyVisibility;
  repostsVisibility: PrivacyVisibility;
  messagesFrom: MessagesFrom;
  commentsFrom: PrivacyVisibility;
  onlineFriends: OnlineVisibility;
  onlineStrangers: OnlineVisibility;
};

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
};

const DEFAULT_PRIVACY: UserSettingsPrivacyDraft = {
  friendsVisibility: "all",
  subscriptionsVisibility: "all",
  postsVisibility: "all",
  likesVisibility: "friends",
  repostsVisibility: "all",
  messagesFrom: "all",
  commentsFrom: "all",
  onlineFriends: "visible",
  onlineStrangers: "hidden",
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
  return { ...DEFAULT_PRIVACY };
}

export function defaultUserSettingsLocalPrefs(): UserSettingsLocalPrefs {
  return {
    notifications: { ...DEFAULT_NOTIFICATIONS },
    customization: { ...DEFAULT_CUSTOMIZATION },
  };
}

function parsePrivacyVisibility(value: unknown, fallback: PrivacyVisibility): PrivacyVisibility {
  if (value === "all" || value === "friends" || value === "none") return value;
  return fallback;
}

function parseMessagesFrom(value: unknown, fallback: MessagesFrom): MessagesFrom {
  if (value === "all" || value === "friends") return value;
  return fallback;
}

function parseOnlineVisibility(value: unknown, fallback: OnlineVisibility): OnlineVisibility {
  if (value === "visible" || value === "hidden") return value;
  return fallback;
}

export function privacyDraftFromApi(raw: unknown): UserSettingsPrivacyDraft {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    friendsVisibility: parsePrivacyVisibility(source.friendsVisibility, DEFAULT_PRIVACY.friendsVisibility),
    subscriptionsVisibility: parsePrivacyVisibility(source.subscriptionsVisibility, DEFAULT_PRIVACY.subscriptionsVisibility),
    postsVisibility: parsePrivacyVisibility(source.postsVisibility, DEFAULT_PRIVACY.postsVisibility),
    likesVisibility: parsePrivacyVisibility(source.likesVisibility, DEFAULT_PRIVACY.likesVisibility),
    repostsVisibility: parsePrivacyVisibility(source.repostsVisibility, DEFAULT_PRIVACY.repostsVisibility),
    messagesFrom: parseMessagesFrom(source.messagesFrom, DEFAULT_PRIVACY.messagesFrom),
    commentsFrom: parsePrivacyVisibility(source.commentsFrom, DEFAULT_PRIVACY.commentsFrom),
    onlineFriends: parseOnlineVisibility(source.onlineFriends, DEFAULT_PRIVACY.onlineFriends),
    onlineStrangers: parseOnlineVisibility(source.onlineStrangers, DEFAULT_PRIVACY.onlineStrangers),
  };
}

export function privacyDraftToApiPayload(draft: UserSettingsPrivacyDraft): UserSettingsPrivacyDraft {
  return { ...draft };
}

export function privacyDraftEqual(a: UserSettingsPrivacyDraft, b: UserSettingsPrivacyDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function accountDraftFromMe(me: {
  displayName: string;
  username: string;
  status?: string;
  birthDate?: string;
}): UserSettingsAccountDraft {
  return {
    displayName: me.displayName.trim(),
    username: me.username.trim().replace(/^@+/, ""),
    status: (me.status ?? "").trim(),
    birthDate: me.birthDate?.trim() ?? "",
  };
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
): UserSettingsDraft {
  return {
    account: accountDraftFromMe(me),
    privacy,
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
  return (
    draft.displayName.trim() !== saved.displayName ||
    draft.username.trim().replace(/^@+/, "") !== saved.username ||
    normalizeProfileStatusForApi(draft.status) !== normalizeProfileStatusForApi(saved.status) ||
    draft.birthDate.trim() !== saved.birthDate.trim()
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
): boolean {
  return (
    accountDraftHasChanges(draft.account, me) ||
    !privacyDraftEqual(draft.privacy, savedPrivacy) ||
    !localPrefsEqual(
      { notifications: draft.notifications, customization: draft.customization },
      savedLocalPrefs,
    )
  );
}

export function validateUserSettingsAccountDraft(draft: UserSettingsAccountDraft): string | null {
  const name = draft.displayName.trim();
  const nick = draft.username.trim().replace(/^@+/, "");
  const statusNorm = normalizeProfileStatusForApi(draft.status);

  if (!name) return "Введите имя.";
  if (!USERNAME_RE.test(nick)) return "Никнейм: 3–50 символов, латиница, цифры и подчёркивание.";
  if (isReservedUsername(nick)) return RESERVED_USERNAME_MESSAGE;

  return validateProfileStatus(statusNorm);
}

export function userSettingsAccountToApiPayload(draft: UserSettingsAccountDraft) {
  return {
    displayName: draft.displayName.trim(),
    username: draft.username.trim().replace(/^@+/, ""),
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
