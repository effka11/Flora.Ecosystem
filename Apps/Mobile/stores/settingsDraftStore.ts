import {
  apiGetFeedSettings,
  apiUpdateFeedSettings,
  isApiRequestError,
} from "@flora/client-core/api";
import {
  apiDeleteAvatar,
  apiGetMe,
  apiGetPrivacySettings,
  apiUpdatePrivacySettings,
  apiUpdateProfile,
} from "@flora/client-core/auth";
import type { MeResponse } from "@flora/client-core/contracts";
import type { ImagePickerAsset } from "expo-image-picker";
import { create } from "zustand";
import { avatarUploadErrorMessage, uploadAvatarFromPickerAsset } from "@/lib/avatarUpload";
import { isNativePushEnabled } from "@/lib/pushCapabilities";
import {
  registerPushTokenWithServer,
  unregisterPushTokenFromServer,
} from "@/lib/pushNotifications";
import {
  defaultFeedDraft,
  feedDraftEqual,
  feedDraftFromDto,
  type SettingsFeedDraft,
} from "@/lib/settingsFeedDraft";
import {
  defaultPrivacyDraft,
  privacyDraftEqual,
  type SettingsPrivacyDraft,
} from "@/lib/settingsPrivacyDraft";
import {
  notificationsDraftEqual,
  normalizeNotificationsDraft,
  type SettingsNotificationsDraft,
} from "@/lib/settingsNotificationsDraft";
import {
  loadNotificationsDraft,
  saveNotificationsDraft,
} from "@/lib/settingsNotificationsStorage";
import {
  accountDraftEqual,
  accountDraftFromMe,
  emptyAccountDraft,
  validateAccountDraft,
  type SettingsAccountDraft,
} from "@/stores/settingsAccountDraft";
import { useSessionStore } from "@/stores/sessionStore";

export type { SettingsAccountDraft } from "@/stores/settingsAccountDraft";
export {
  accountDraftEqual,
  accountDraftFromMe,
  emptyAccountDraft,
  validateAccountDraft,
} from "@/stores/settingsAccountDraft";

/** Локальный черновик аватара — на сервер уходит только в saveAll. */
export type SettingsAvatarPending =
  | { kind: "upload"; asset: ImagePickerAsset }
  | { kind: "remove" };

type SettingsDraftState = {
  account: SettingsAccountDraft;
  baseline: SettingsAccountDraft;
  privacy: SettingsPrivacyDraft;
  baselinePrivacy: SettingsPrivacyDraft;
  feed: SettingsFeedDraft;
  baselineFeed: SettingsFeedDraft;
  notifications: SettingsNotificationsDraft;
  baselineNotifications: SettingsNotificationsDraft;
  privacyReady: boolean;
  feedReady: boolean;
  avatarPending: SettingsAvatarPending | null;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  saveSuccess: string | null;
  syncFromMe: (me: MeResponse | null) => void;
  loadPrivacy: () => Promise<void>;
  loadFeed: () => Promise<void>;
  updateAccount: (patch: Partial<SettingsAccountDraft>) => void;
  updatePrivacy: (patch: Partial<SettingsPrivacyDraft>) => void;
  updateFeed: (patch: Partial<SettingsFeedDraft>) => void;
  updateNotifications: (patch: Partial<SettingsNotificationsDraft>) => void;
  setAvatarPending: (pending: SettingsAvatarPending | null) => void;
  clearSaveFeedback: () => void;
  discardChanges: () => void;
  saveAll: () => Promise<{ ok: boolean; error?: string }>;
};

type SnapshotArgs = {
  account: SettingsAccountDraft;
  baseline: SettingsAccountDraft;
  privacy: SettingsPrivacyDraft;
  baselinePrivacy: SettingsPrivacyDraft;
  feed: SettingsFeedDraft;
  baselineFeed: SettingsFeedDraft;
  notifications: SettingsNotificationsDraft;
  baselineNotifications: SettingsNotificationsDraft;
  avatarPending: SettingsAvatarPending | null;
};

function computeDirty(args: SnapshotArgs): boolean {
  return (
    !accountDraftEqual(args.account, args.baseline) ||
    !privacyDraftEqual(args.privacy, args.baselinePrivacy) ||
    !feedDraftEqual(args.feed, args.baselineFeed) ||
    !notificationsDraftEqual(args.notifications, args.baselineNotifications) ||
    args.avatarPending !== null
  );
}

function snapshot(args: SnapshotArgs): Pick<
  SettingsDraftState,
  | "account"
  | "baseline"
  | "privacy"
  | "baselinePrivacy"
  | "feed"
  | "baselineFeed"
  | "notifications"
  | "baselineNotifications"
  | "avatarPending"
  | "dirty"
> {
  return {
    account: args.account,
    baseline: args.baseline,
    privacy: args.privacy,
    baselinePrivacy: args.baselinePrivacy,
    feed: args.feed,
    baselineFeed: args.baselineFeed,
    notifications: args.notifications,
    baselineNotifications: args.baselineNotifications,
    avatarPending: args.avatarPending,
    dirty: computeDirty(args),
  };
}

const initialNotifications = loadNotificationsDraft();

export const useSettingsDraftStore = create<SettingsDraftState>((set, get) => ({
  account: emptyAccountDraft(),
  baseline: emptyAccountDraft(),
  privacy: defaultPrivacyDraft(),
  baselinePrivacy: defaultPrivacyDraft(),
  feed: defaultFeedDraft(),
  baselineFeed: defaultFeedDraft(),
  notifications: initialNotifications,
  baselineNotifications: initialNotifications,
  privacyReady: false,
  feedReady: false,
  avatarPending: null,
  dirty: false,
  saving: false,
  saveError: null,
  saveSuccess: null,

  syncFromMe(me) {
    const next = accountDraftFromMe(me);
    const {
      dirty,
      saving,
      privacy,
      baselinePrivacy,
      feed,
      baselineFeed,
      notifications,
      baselineNotifications,
      avatarPending,
    } = get();
    if (saving) return;
    if (dirty) return;
    set({
      ...snapshot({
        account: next,
        baseline: next,
        privacy,
        baselinePrivacy,
        feed,
        baselineFeed,
        notifications,
        baselineNotifications,
        avatarPending,
      }),
      saveError: null,
      saveSuccess: null,
    });
  },

  async loadPrivacy() {
    const {
      saving,
      privacy,
      baselinePrivacy,
      feed,
      baselineFeed,
      account,
      baseline,
      notifications,
      baselineNotifications,
      avatarPending,
    } = get();
    if (saving) return;
    const privacyDirty = !privacyDraftEqual(privacy, baselinePrivacy);
    if (privacyDirty) return;

    try {
      const next = await apiGetPrivacySettings();
      set({
        ...snapshot({
          account,
          baseline,
          privacy: next,
          baselinePrivacy: next,
          feed,
          baselineFeed,
          notifications,
          baselineNotifications,
          avatarPending,
        }),
        privacyReady: true,
      });
    } catch {
      const fallback = defaultPrivacyDraft();
      set({
        ...snapshot({
          account,
          baseline,
          privacy: fallback,
          baselinePrivacy: fallback,
          feed,
          baselineFeed,
          notifications,
          baselineNotifications,
          avatarPending,
        }),
        privacyReady: true,
      });
    }
  },

  async loadFeed() {
    const {
      saving,
      feed,
      baselineFeed,
      account,
      baseline,
      privacy,
      baselinePrivacy,
      notifications,
      baselineNotifications,
      avatarPending,
    } = get();
    if (saving) return;
    const feedDirty = !feedDraftEqual(feed, baselineFeed);
    if (feedDirty) return;

    try {
      const next = feedDraftFromDto(await apiGetFeedSettings());
      set({
        ...snapshot({
          account,
          baseline,
          privacy,
          baselinePrivacy,
          feed: next,
          baselineFeed: next,
          notifications,
          baselineNotifications,
          avatarPending,
        }),
        feedReady: true,
      });
    } catch {
      const fallback = defaultFeedDraft();
      set({
        ...snapshot({
          account,
          baseline,
          privacy,
          baselinePrivacy,
          feed: fallback,
          baselineFeed: fallback,
          notifications,
          baselineNotifications,
          avatarPending,
        }),
        feedReady: true,
      });
    }
  },

  updateAccount(patch) {
    const {
      baseline,
      privacy,
      baselinePrivacy,
      feed,
      baselineFeed,
      notifications,
      baselineNotifications,
      avatarPending,
    } = get();
    const account = { ...get().account, ...patch };
    set({
      ...snapshot({
        account,
        baseline,
        privacy,
        baselinePrivacy,
        feed,
        baselineFeed,
        notifications,
        baselineNotifications,
        avatarPending,
      }),
      saveError: null,
      saveSuccess: null,
    });
  },

  updatePrivacy(patch) {
    const {
      account,
      baseline,
      baselinePrivacy,
      feed,
      baselineFeed,
      notifications,
      baselineNotifications,
      avatarPending,
    } = get();
    const privacy = { ...get().privacy, ...patch };
    set({
      ...snapshot({
        account,
        baseline,
        privacy,
        baselinePrivacy,
        feed,
        baselineFeed,
        notifications,
        baselineNotifications,
        avatarPending,
      }),
      saveError: null,
      saveSuccess: null,
    });
  },

  updateFeed(patch) {
    const {
      account,
      baseline,
      privacy,
      baselinePrivacy,
      baselineFeed,
      notifications,
      baselineNotifications,
      avatarPending,
    } = get();
    const feed = { ...get().feed, ...patch };
    set({
      ...snapshot({
        account,
        baseline,
        privacy,
        baselinePrivacy,
        feed,
        baselineFeed,
        notifications,
        baselineNotifications,
        avatarPending,
      }),
      saveError: null,
      saveSuccess: null,
    });
  },

  updateNotifications(patch) {
    const {
      account,
      baseline,
      privacy,
      baselinePrivacy,
      feed,
      baselineFeed,
      baselineNotifications,
      avatarPending,
    } = get();
    const notifications = normalizeNotificationsDraft({ ...get().notifications, ...patch });
    set({
      ...snapshot({
        account,
        baseline,
        privacy,
        baselinePrivacy,
        feed,
        baselineFeed,
        notifications,
        baselineNotifications,
        avatarPending,
      }),
      saveError: null,
      saveSuccess: null,
    });
  },

  setAvatarPending(pending) {
    const {
      account,
      baseline,
      privacy,
      baselinePrivacy,
      feed,
      baselineFeed,
      notifications,
      baselineNotifications,
    } = get();
    set({
      ...snapshot({
        account,
        baseline,
        privacy,
        baselinePrivacy,
        feed,
        baselineFeed,
        notifications,
        baselineNotifications,
        avatarPending: pending,
      }),
      saveError: null,
      saveSuccess: null,
    });
  },

  clearSaveFeedback() {
    set({ saveError: null, saveSuccess: null });
  },

  discardChanges() {
    const { baseline, baselinePrivacy, baselineFeed, baselineNotifications, saving } = get();
    if (saving) return;
    set({
      ...snapshot({
        account: { ...baseline },
        baseline,
        privacy: { ...baselinePrivacy },
        baselinePrivacy,
        feed: { ...baselineFeed },
        baselineFeed,
        notifications: normalizeNotificationsDraft(baselineNotifications),
        baselineNotifications,
        avatarPending: null,
      }),
      saveError: null,
      saveSuccess: null,
    });
  },

  async saveAll() {
    const {
      account,
      baseline,
      privacy,
      baselinePrivacy,
      feed,
      baselineFeed,
      notifications,
      baselineNotifications,
      dirty,
      avatarPending,
    } = get();
    if (!dirty) {
      set({ saveSuccess: "Изменений нет.", saveError: null });
      return { ok: true };
    }

    const accountChanged = !accountDraftEqual(account, baseline);
    const privacyChanged = !privacyDraftEqual(privacy, baselinePrivacy);
    const feedChanged = !feedDraftEqual(feed, baselineFeed);
    const notificationsChanged = !notificationsDraftEqual(notifications, baselineNotifications);

    if (accountChanged) {
      const validationError = validateAccountDraft(account);
      if (validationError) {
        set({ saveError: validationError, saveSuccess: null });
        return { ok: false, error: validationError };
      }
    }

    set({ saving: true, saveError: null, saveSuccess: null });
    try {
      if (avatarPending?.kind === "upload") {
        await uploadAvatarFromPickerAsset(avatarPending.asset);
      } else if (avatarPending?.kind === "remove") {
        await apiDeleteAvatar();
      }

      if (accountChanged) {
        const nick = account.username.trim().replace(/^@+/, "").toLowerCase();
        await apiUpdateProfile({
          displayName: account.displayName.trim(),
          username: nick,
          status: account.status.trim(),
          birthDate: account.birthDate.trim(),
        });
      }

      let nextPrivacy = baselinePrivacy;
      if (privacyChanged) {
        nextPrivacy = await apiUpdatePrivacySettings({ ...privacy });
      }

      let nextFeed = baselineFeed;
      if (feedChanged) {
        nextFeed = feedDraftFromDto(await apiUpdateFeedSettings({ ...feed }));
      }

      let nextNotifications = baselineNotifications;
      if (notificationsChanged) {
        nextNotifications = normalizeNotificationsDraft(notifications);
        saveNotificationsDraft(nextNotifications);
        if (isNativePushEnabled()) {
          if (nextNotifications.pushEnabled) {
            await registerPushTokenWithServer(useSessionStore.getState().me?.userUuid ?? null);
          } else {
            await unregisterPushTokenFromServer();
          }
        }
      }

      const updated = await apiGetMe();
      useSessionStore.getState().setMe(updated);
      const nextAccount = accountDraftFromMe(updated);
      set({
        ...snapshot({
          account: nextAccount,
          baseline: nextAccount,
          privacy: nextPrivacy,
          baselinePrivacy: nextPrivacy,
          feed: nextFeed,
          baselineFeed: nextFeed,
          notifications: nextNotifications,
          baselineNotifications: nextNotifications,
          avatarPending: null,
        }),
        privacyReady: true,
        feedReady: true,
        saving: false,
        saveSuccess: "Настройки сохранены.",
        saveError: null,
      });
      return { ok: true };
    } catch (e) {
      const error =
        avatarPending?.kind === "upload"
          ? avatarUploadErrorMessage(e)
          : isApiRequestError(e)
            ? e.message
            : e instanceof Error
              ? e.message
              : "Не удалось сохранить настройки.";
      set({ saving: false, saveError: error, saveSuccess: null });
      return { ok: false, error };
    }
  },
}));
