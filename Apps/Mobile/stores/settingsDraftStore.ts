import { isApiRequestError } from "@flora/client-core/api";
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
import {
  defaultPrivacyDraft,
  privacyDraftEqual,
  privacyDraftFromApi,
  type SettingsPrivacyDraft,
} from "@/lib/settingsPrivacyDraft";
import { useSessionStore } from "@/stores/sessionStore";

export type SettingsAccountDraft = {
  displayName: string;
  username: string;
  birthDate: string;
  status: string;
};

/** Локальный черновик аватара — на сервер уходит только в saveAll. */
export type SettingsAvatarPending =
  | { kind: "upload"; asset: ImagePickerAsset }
  | { kind: "remove" };

const USERNAME_RE = /^[a-z0-9_]{3,50}$/;

const EMPTY_ACCOUNT: SettingsAccountDraft = {
  displayName: "",
  username: "",
  birthDate: "",
  status: "",
};

export function accountDraftFromMe(me: MeResponse | null | undefined): SettingsAccountDraft {
  if (!me) return { ...EMPTY_ACCOUNT };
  return {
    displayName: me.displayName ?? "",
    username: (me.username ?? "").replace(/^@+/, "").toLowerCase(),
    birthDate: me.birthDate ?? "",
    status: me.status ?? "",
  };
}

export function accountDraftEqual(a: SettingsAccountDraft, b: SettingsAccountDraft): boolean {
  return (
    a.displayName.trim() === b.displayName.trim() &&
    a.username.trim().replace(/^@+/, "").toLowerCase() ===
      b.username.trim().replace(/^@+/, "").toLowerCase() &&
    a.birthDate.trim() === b.birthDate.trim() &&
    a.status.trim() === b.status.trim()
  );
}

export function validateAccountDraft(draft: SettingsAccountDraft): string | null {
  const name = draft.displayName.trim();
  const nick = draft.username.trim().replace(/^@+/, "").toLowerCase();
  const statusNorm = draft.status.trim();

  if (!name) return "Введите имя.";
  if (!USERNAME_RE.test(nick)) {
    return "Никнейм: 3–50 символов, только строчная латиница, цифры и подчёркивание.";
  }
  if (statusNorm.length > 150) return "Статус не более 150 символов.";
  return null;
}

type SettingsDraftState = {
  account: SettingsAccountDraft;
  baseline: SettingsAccountDraft;
  privacy: SettingsPrivacyDraft;
  baselinePrivacy: SettingsPrivacyDraft;
  privacyReady: boolean;
  avatarPending: SettingsAvatarPending | null;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  saveSuccess: string | null;
  syncFromMe: (me: MeResponse | null) => void;
  loadPrivacy: () => Promise<void>;
  updateAccount: (patch: Partial<SettingsAccountDraft>) => void;
  updatePrivacy: (patch: Partial<SettingsPrivacyDraft>) => void;
  setAvatarPending: (pending: SettingsAvatarPending | null) => void;
  clearSaveFeedback: () => void;
  discardChanges: () => void;
  saveAll: () => Promise<{ ok: boolean; error?: string }>;
};

function computeDirty(
  account: SettingsAccountDraft,
  baseline: SettingsAccountDraft,
  privacy: SettingsPrivacyDraft,
  baselinePrivacy: SettingsPrivacyDraft,
  avatarPending: SettingsAvatarPending | null,
): boolean {
  return (
    !accountDraftEqual(account, baseline) ||
    !privacyDraftEqual(privacy, baselinePrivacy) ||
    avatarPending !== null
  );
}

function snapshot(
  account: SettingsAccountDraft,
  baseline: SettingsAccountDraft,
  privacy: SettingsPrivacyDraft,
  baselinePrivacy: SettingsPrivacyDraft,
  avatarPending: SettingsAvatarPending | null,
): Pick<
  SettingsDraftState,
  "account" | "baseline" | "privacy" | "baselinePrivacy" | "avatarPending" | "dirty"
> {
  return {
    account,
    baseline,
    privacy,
    baselinePrivacy,
    avatarPending,
    dirty: computeDirty(account, baseline, privacy, baselinePrivacy, avatarPending),
  };
}

export const useSettingsDraftStore = create<SettingsDraftState>((set, get) => ({
  account: { ...EMPTY_ACCOUNT },
  baseline: { ...EMPTY_ACCOUNT },
  privacy: defaultPrivacyDraft(),
  baselinePrivacy: defaultPrivacyDraft(),
  privacyReady: false,
  avatarPending: null,
  dirty: false,
  saving: false,
  saveError: null,
  saveSuccess: null,

  syncFromMe(me) {
    const next = accountDraftFromMe(me);
    const { dirty, saving, privacy, baselinePrivacy, avatarPending } = get();
    if (saving) return;
    if (dirty) return;
    set({
      ...snapshot(next, next, privacy, baselinePrivacy, avatarPending),
      saveError: null,
      saveSuccess: null,
    });
  },

  async loadPrivacy() {
    const { saving, privacy, baselinePrivacy, account, baseline, avatarPending } = get();
    if (saving) return;
    const privacyDirty = !privacyDraftEqual(privacy, baselinePrivacy);
    if (privacyDirty) return;

    try {
      const raw = await apiGetPrivacySettings();
      const next = privacyDraftFromApi(raw);
      set({
        ...snapshot(account, baseline, next, next, avatarPending),
        privacyReady: true,
      });
    } catch {
      const fallback = defaultPrivacyDraft();
      set({
        ...snapshot(account, baseline, fallback, fallback, avatarPending),
        privacyReady: true,
      });
    }
  },

  updateAccount(patch) {
    const { baseline, privacy, baselinePrivacy, avatarPending } = get();
    const account = { ...get().account, ...patch };
    set({
      ...snapshot(account, baseline, privacy, baselinePrivacy, avatarPending),
      saveError: null,
      saveSuccess: null,
    });
  },

  updatePrivacy(patch) {
    const { account, baseline, baselinePrivacy, avatarPending } = get();
    const privacy = { ...get().privacy, ...patch };
    set({
      ...snapshot(account, baseline, privacy, baselinePrivacy, avatarPending),
      saveError: null,
      saveSuccess: null,
    });
  },

  setAvatarPending(pending) {
    const { account, baseline, privacy, baselinePrivacy } = get();
    set({
      ...snapshot(account, baseline, privacy, baselinePrivacy, pending),
      saveError: null,
      saveSuccess: null,
    });
  },

  clearSaveFeedback() {
    set({ saveError: null, saveSuccess: null });
  },

  discardChanges() {
    const { baseline, baselinePrivacy, saving } = get();
    if (saving) return;
    set({
      ...snapshot({ ...baseline }, baseline, { ...baselinePrivacy }, baselinePrivacy, null),
      saveError: null,
      saveSuccess: null,
    });
  },

  async saveAll() {
    const { account, baseline, privacy, baselinePrivacy, dirty, avatarPending } = get();
    if (!dirty) {
      set({ saveSuccess: "Изменений нет.", saveError: null });
      return { ok: true };
    }

    const accountChanged = !accountDraftEqual(account, baseline);
    const privacyChanged = !privacyDraftEqual(privacy, baselinePrivacy);

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
        const raw = await apiUpdatePrivacySettings({ ...privacy });
        nextPrivacy = privacyDraftFromApi(raw);
      }

      const updated = await apiGetMe();
      useSessionStore.getState().setMe(updated);
      const nextAccount = accountDraftFromMe(updated);
      set({
        ...snapshot(nextAccount, nextAccount, nextPrivacy, nextPrivacy, null),
        privacyReady: true,
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
