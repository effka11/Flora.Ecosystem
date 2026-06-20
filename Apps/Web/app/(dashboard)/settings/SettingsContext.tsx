"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import {
  ApiRequestError,
  apiGetPrivacySettings,
  apiUpdatePrivacySettings,
  apiUpdateProfile,
} from "@/lib/auth";
import { privacySettingsCache } from "@/lib/dashboardPreload";
import {
  accountDraftHasChanges,
  defaultPrivacyDraft,
  loadUserSettingsLocalPrefs,
  privacyDraftEqual,
  saveUserSettingsLocalPrefs,
  userSettingsAccountToApiPayload,
  userSettingsDraftFromSources,
  userSettingsDraftHasChanges,
  userSettingsDraftToLocalPrefs,
  validateUserSettingsAccountDraft,
  type UserSettingsAccountDraft,
  type UserSettingsCustomizationDraft,
  type UserSettingsDraft,
  type UserSettingsLocalPrefs,
  type UserSettingsNotificationsDraft,
  type UserSettingsPrivacyDraft,
} from "./settingsDraft";

export type SettingsContextValue = {
  ready: boolean;
  draft: UserSettingsDraft;
  updateAccount: (patch: Partial<UserSettingsAccountDraft>) => void;
  updatePrivacy: (patch: Partial<UserSettingsPrivacyDraft>) => void;
  updateNotifications: (patch: Partial<UserSettingsNotificationsDraft>) => void;
  updateCustomization: (patch: Partial<UserSettingsCustomizationDraft>) => void;
  hasUnsavedChanges: boolean;
  saving: boolean;
  saveError: string | null;
  saveSuccess: string | null;
  saveAll: () => Promise<{ ok: boolean; error?: string }>;
  discardChanges: () => void;
  clearSaveFeedback: () => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

const EMPTY_DRAFT = userSettingsDraftFromSources(
  { displayName: "", username: "" },
  loadUserSettingsLocalPrefs(),
  defaultPrivacyDraft(),
);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { me, loading, refresh } = useCurrentUser();
  const userIdRef = useRef<string | null>(null);
  const [savedLocalPrefs, setSavedLocalPrefs] = useState<UserSettingsLocalPrefs>(() => loadUserSettingsLocalPrefs());
  const [savedPrivacy, setSavedPrivacy] = useState<UserSettingsPrivacyDraft>(() => defaultPrivacyDraft());
  const [draft, setDraft] = useState<UserSettingsDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!me) {
      userIdRef.current = null;
      return;
    }
    if (userIdRef.current === me.userUuid) return;

    userIdRef.current = me.userUuid;
    const prefs = loadUserSettingsLocalPrefs();
    setSavedLocalPrefs(prefs);
    setSaveError(null);
    setSaveSuccess(null);

    void (async () => {
      const cachedPrivacy = privacySettingsCache.peek();
      if (cachedPrivacy) {
        setSavedPrivacy(cachedPrivacy);
        setDraft(userSettingsDraftFromSources(me, prefs, cachedPrivacy));
      }
      const privacy = await privacySettingsCache.get();
      privacySettingsCache.set(privacy);
      setSavedPrivacy(privacy);
      setDraft(userSettingsDraftFromSources(me, prefs, privacy));
    })();
  }, [me]);

  const clearSaveFeedback = useCallback(() => {
    setSaveError(null);
    setSaveSuccess(null);
  }, []);

  const updateAccount = useCallback(
    (patch: Partial<UserSettingsAccountDraft>) => {
      clearSaveFeedback();
      setDraft((prev) => ({ ...prev, account: { ...prev.account, ...patch } }));
    },
    [clearSaveFeedback],
  );

  const updatePrivacy = useCallback(
    (patch: Partial<UserSettingsPrivacyDraft>) => {
      clearSaveFeedback();
      setDraft((prev) => ({ ...prev, privacy: { ...prev.privacy, ...patch } }));
    },
    [clearSaveFeedback],
  );

  const updateNotifications = useCallback(
    (patch: Partial<UserSettingsNotificationsDraft>) => {
      clearSaveFeedback();
      setDraft((prev) => ({ ...prev, notifications: { ...prev.notifications, ...patch } }));
    },
    [clearSaveFeedback],
  );

  const updateCustomization = useCallback(
    (patch: Partial<UserSettingsCustomizationDraft>) => {
      clearSaveFeedback();
      setDraft((prev) => ({ ...prev, customization: { ...prev.customization, ...patch } }));
    },
    [clearSaveFeedback],
  );

  const discardChanges = useCallback(() => {
    if (!me) return;
    const prefs = loadUserSettingsLocalPrefs();
    setSavedLocalPrefs(prefs);
    setDraft(userSettingsDraftFromSources(me, prefs, savedPrivacy));
    setSaveError(null);
    setSaveSuccess(null);
  }, [me, savedPrivacy]);

  const hasUnsavedChanges =
    Boolean(me) && userSettingsDraftHasChanges(draft, me!, savedLocalPrefs, savedPrivacy);

  const saveAll = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!me || saving) return { ok: false };

    const validationError = validateUserSettingsAccountDraft(draft.account);
    if (validationError) {
      setSaveError(validationError);
      setSaveSuccess(null);
      return { ok: false, error: validationError };
    }

    if (!userSettingsDraftHasChanges(draft, me, savedLocalPrefs, savedPrivacy)) {
      setSaveError(null);
      setSaveSuccess("Изменений нет.");
      return { ok: true };
    }

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const localPrefs = userSettingsDraftToLocalPrefs(draft);
      const accountPayload = userSettingsAccountToApiPayload(draft.account);
      const accountChanged = accountDraftHasChanges(draft.account, me);
      const privacyChanged = !privacyDraftEqual(draft.privacy, savedPrivacy);
      const prefsChanged = JSON.stringify(localPrefs) !== JSON.stringify(savedLocalPrefs);

      if (accountChanged) {
        await apiUpdateProfile(accountPayload);
        await refresh();
      }

      let nextPrivacy = savedPrivacy;
      if (privacyChanged) {
        nextPrivacy = await apiUpdatePrivacySettings(draft.privacy);
        privacySettingsCache.set(nextPrivacy);
        setSavedPrivacy(nextPrivacy);
      }

      if (prefsChanged) {
        saveUserSettingsLocalPrefs(localPrefs);
        setSavedLocalPrefs(localPrefs);
      }

      const nextAccount = accountChanged
        ? {
            displayName: accountPayload.displayName,
            username: accountPayload.username,
            status: accountPayload.status ?? "",
            birthDate: accountPayload.birthDate ?? "",
          }
        : draft.account;

      setDraft({
        account: nextAccount,
        privacy: nextPrivacy,
        ...localPrefs,
      });

      setSaveSuccess("Настройки сохранены.");
      return { ok: true };
    } catch (e) {
      const message =
        e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось сохранить настройки.";
      setSaveError(message);
      return { ok: false, error: message };
    } finally {
      setSaving(false);
    }
  }, [draft, me, refresh, savedLocalPrefs, savedPrivacy, saving]);

  const ready = Boolean(me && !loading);

  return (
    <SettingsContext.Provider
      value={{
        ready,
        draft,
        updateAccount,
        updatePrivacy,
        updateNotifications,
        updateCustomization,
        hasUnsavedChanges,
        saving,
        saveError,
        saveSuccess,
        saveAll,
        discardChanges,
        clearSaveFeedback,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings должен вызываться внутри SettingsProvider.");
  }
  return ctx;
}
