import { isApiRequestError } from "@flora/client-core/api";
import { apiDeleteAvatar, apiGetMe, apiUpdateProfile } from "@flora/client-core/auth";
import type { MeResponse } from "@flora/client-core/contracts";
import type { ImagePickerAsset } from "expo-image-picker";
import { create } from "zustand";
import { avatarUploadErrorMessage, uploadAvatarFromPickerAsset } from "@/lib/avatarUpload";
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
  avatarPending: SettingsAvatarPending | null;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  saveSuccess: string | null;
  /** Подтянуть draft из /me, если нет локальных правок. */
  syncFromMe: (me: MeResponse | null) => void;
  updateAccount: (patch: Partial<SettingsAccountDraft>) => void;
  setAvatarPending: (pending: SettingsAvatarPending | null) => void;
  clearSaveFeedback: () => void;
  /** Откатить локальный черновик к baseline (без запроса на сервер). */
  discardChanges: () => void;
  /** Сохранить все dirty-секции (аккаунт + аватар). */
  saveAll: () => Promise<{ ok: boolean; error?: string }>;
};

function withDirty(
  account: SettingsAccountDraft,
  baseline: SettingsAccountDraft,
  avatarPending: SettingsAvatarPending | null,
): Pick<SettingsDraftState, "account" | "baseline" | "avatarPending" | "dirty"> {
  return {
    account,
    baseline,
    avatarPending,
    dirty: !accountDraftEqual(account, baseline) || avatarPending !== null,
  };
}

export const useSettingsDraftStore = create<SettingsDraftState>((set, get) => ({
  account: { ...EMPTY_ACCOUNT },
  baseline: { ...EMPTY_ACCOUNT },
  avatarPending: null,
  dirty: false,
  saving: false,
  saveError: null,
  saveSuccess: null,

  syncFromMe(me) {
    const next = accountDraftFromMe(me);
    const { dirty, saving } = get();
    if (saving) return;
    if (dirty) return;
    set({ ...withDirty(next, next, null), saveError: null, saveSuccess: null });
  },

  updateAccount(patch) {
    const { baseline, avatarPending } = get();
    const account = { ...get().account, ...patch };
    set({
      ...withDirty(account, baseline, avatarPending),
      saveError: null,
      saveSuccess: null,
    });
  },

  setAvatarPending(pending) {
    const { account, baseline } = get();
    set({
      ...withDirty(account, baseline, pending),
      saveError: null,
      saveSuccess: null,
    });
  },

  clearSaveFeedback() {
    set({ saveError: null, saveSuccess: null });
  },

  discardChanges() {
    const { baseline, saving } = get();
    if (saving) return;
    set({
      ...withDirty({ ...baseline }, baseline, null),
      saveError: null,
      saveSuccess: null,
    });
  },

  async saveAll() {
    const { account, baseline, dirty, avatarPending } = get();
    if (!dirty) {
      set({ saveSuccess: "Изменений нет.", saveError: null });
      return { ok: true };
    }

    const accountChanged = !accountDraftEqual(account, baseline);
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

      const updated = await apiGetMe();
      useSessionStore.getState().setMe(updated);
      const next = accountDraftFromMe(updated);
      set({
        ...withDirty(next, next, null),
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
