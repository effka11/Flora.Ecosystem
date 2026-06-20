"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { communitySettingsHref } from "@/app/(dashboard)/communities/communitiesSeed";
import { ApiRequestError, isDevLocalOfflineSession } from "@/lib/auth";
import { apiUpdateCommunity, type CommunityProfileDto } from "@/lib/socialApi";
import { notifyOwnedCommunitiesChanged } from "@/app/(dashboard)/communities/ownedCommunitiesEvents";
import {
  communitySettingsDraftFromProfile,
  communitySettingsDraftHasChanges,
  communitySettingsDraftToUpdatePayload,
  type CommunitySettingsDraft,
  validateCommunitySettingsDraft,
} from "./communitySettingsDraft";

export type CommunitySettingsContextValue = {
  community: CommunityProfileDto;
  reload: () => Promise<void>;
  draft: CommunitySettingsDraft;
  updateDraft: (patch: Partial<CommunitySettingsDraft>) => void;
  hasUnsavedChanges: boolean;
  saving: boolean;
  saveError: string | null;
  saveSuccess: string | null;
  saveAll: () => Promise<{ ok: boolean; error?: string }>;
  discardChanges: () => void;
  clearSaveFeedback: () => void;
};

const CommunitySettingsContext = createContext<CommunitySettingsContextValue | null>(null);

export function CommunitySettingsProvider({
  community,
  reload,
  children,
}: {
  community: CommunityProfileDto;
  reload: () => Promise<void>;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const communityIdRef = useRef(community.communityId);
  const [draft, setDraft] = useState<CommunitySettingsDraft>(() => communitySettingsDraftFromProfile(community));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (communityIdRef.current === community.communityId) return;
    communityIdRef.current = community.communityId;
    setDraft(communitySettingsDraftFromProfile(community));
    setSaveError(null);
    setSaveSuccess(null);
  }, [community]);

  const updateDraft = useCallback((patch: Partial<CommunitySettingsDraft>) => {
    setSaveError(null);
    setSaveSuccess(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  const clearSaveFeedback = useCallback(() => {
    setSaveError(null);
    setSaveSuccess(null);
  }, []);

  const hasUnsavedChanges = communitySettingsDraftHasChanges(draft, community);

  const discardChanges = useCallback(() => {
    setDraft(communitySettingsDraftFromProfile(community));
    setSaveError(null);
    setSaveSuccess(null);
  }, [community]);

  const saveAll = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (saving) return { ok: false };

    const validationError = validateCommunitySettingsDraft(draft);
    if (validationError) {
      setSaveError(validationError);
      setSaveSuccess(null);
      return { ok: false, error: validationError };
    }

    if (!communitySettingsDraftHasChanges(draft, community)) {
      setSaveError(null);
      setSaveSuccess("Изменений нет.");
      return { ok: true };
    }

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const payload = communitySettingsDraftToUpdatePayload(draft);
      const updated = await apiUpdateCommunity(community.communityId, payload);
      notifyOwnedCommunitiesChanged();
      await reload();
      setDraft(communitySettingsDraftFromProfile(updated));
      setSaveSuccess("Настройки сохранены.");
      if (updated.slug !== community.slug && !isDevLocalOfflineSession()) {
        router.replace(communitySettingsHref({ id: updated.communityId, slug: updated.slug }, "general"));
      }
      return { ok: true };
    } catch (e) {
      const message =
        e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось сохранить настройки.";
      setSaveError(message);
      return { ok: false, error: message };
    } finally {
      setSaving(false);
    }
  }, [community, draft, reload, router, saving]);

  return (
    <CommunitySettingsContext.Provider
      value={{
        community,
        reload,
        draft,
        updateDraft,
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
    </CommunitySettingsContext.Provider>
  );
}

export function useCommunitySettings() {
  const ctx = useContext(CommunitySettingsContext);
  if (!ctx) {
    throw new Error("useCommunitySettings должен вызываться внутри CommunitySettingsProvider.");
  }
  return ctx;
}
