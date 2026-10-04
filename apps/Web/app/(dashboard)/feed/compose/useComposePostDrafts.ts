"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergePostImageFiles } from "@/lib/composePostImages";
import { clampPostContent } from "@/lib/postContentLimits";
import {
  apiCreatePostDraft,
  apiDeletePostDraft,
  apiListPostDrafts,
  apiUpdatePostDraft,
  type PostDraftDto,
} from "@/lib/socialApi";
import {
  COMPOSE_DRAFT_LABEL_MAX_LEN,
  COMPOSE_MAX_DRAFTS,
  normalizeComposeDraftLabel,
  type ComposeDraft,
} from "./ComposeDraftsSidebar";
import {
  clearComposeDraftImages,
  clearComposeNeutralImages,
  fingerprintComposeImages,
  readComposeDraftImages,
  readComposeNeutralImages,
  writeComposeDraftImages,
  writeComposeNeutralImages,
} from "./composeDraftImageStore";
import { composeModeToDraftScope } from "./composeModes";
import {
  clearComposeNeutralBodyCache,
  readComposeNeutralBodyCache,
  writeComposeNeutralBodyCache,
} from "./composeNeutralCache";

function mapDraftDto(dto: PostDraftDto): ComposeDraft {
  return {
    id: dto.draftUuid,
    label: dto.label,
    body: dto.content,
  };
}

export function useComposePostDrafts(composeModeId: string) {
  const { communityId, scopeKey } = useMemo(() => composeModeToDraftScope(composeModeId), [composeModeId]);

  const [drafts, setDrafts] = useState<ComposeDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [activeDraftId, setActiveDraftId] = useState("");
  const [freeformBody, setFreeformBody] = useState(() => readComposeNeutralBodyCache(scopeKey));
  const [freeformImages, setFreeformImages] = useState<File[]>([]);
  const [draftImagesById, setDraftImagesById] = useState<Record<string, File[]>>({});
  const [draftSearch, setDraftSearch] = useState("");
  /** Последний контент, синхронизированный с API (для кнопки «Сохранить»). */
  const [savedBodies, setSavedBodies] = useState<Record<string, string>>({});
  /** Отпечаток фото, сохранённых для черновика (IndexedDB при «Сохранить»). */
  const [savedImageFingerprints, setSavedImageFingerprints] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const activeDraftIdRef = useRef(activeDraftId);
  activeDraftIdRef.current = activeDraftId;
  const loadedDraftImagesRef = useRef<Set<string>>(new Set());

  const flushDraftContent = useCallback(async (draftId: string, content: string) => {
    try {
      const updated = await apiUpdatePostDraft(draftId, { content });
      const mapped = mapDraftDto(updated);
      setDrafts((prev) => prev.map((d) => (d.id === draftId ? mapped : d)));
      setSavedBodies((prev) => ({ ...prev, [draftId]: mapped.body }));
    } catch {
      /* тихо: при следующем сохранении или перезагрузке подтянется с сервера */
    }
  }, []);

  const flushDraftImages = useCallback(async (draftId: string, files: File[]) => {
    try {
      await writeComposeDraftImages(draftId, files);
      setSavedImageFingerprints((prev) => ({
        ...prev,
        [draftId]: fingerprintComposeImages(files),
      }));
    } catch {
      /* quota / private mode */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (cancelled) return;

      setActiveDraftId("");
      setFreeformBody(readComposeNeutralBodyCache(scopeKey));
      setFreeformImages([]);
      setDraftImagesById({});
      setDraftSearch("");
      setDraftsError(null);
      setDraftsLoading(true);
      setSavedBodies({});
      setSavedImageFingerprints({});
      loadedDraftImagesRef.current = new Set();

      const neutralImages = await readComposeNeutralImages(scopeKey);
      if (cancelled) return;
      setFreeformImages(neutralImages);

      try {
        const list = await apiListPostDrafts({ communityId });
        if (cancelled) return;
        const mapped = list.map(mapDraftDto);
        setDrafts(mapped);
        setSavedBodies(Object.fromEntries(mapped.map((d) => [d.id, d.body])));

        const fingerprints: Record<string, string> = {};
        await Promise.all(
          mapped.map(async (draft) => {
            const images = await readComposeDraftImages(draft.id);
            if (cancelled) return;
            if (images.length > 0) {
              fingerprints[draft.id] = fingerprintComposeImages(images);
            }
          }),
        );
        if (!cancelled) setSavedImageFingerprints(fingerprints);
      } catch (e) {
        if (!cancelled) {
          setDraftsError(e instanceof Error ? e.message : "Не удалось загрузить черновики");
        }
      } finally {
        if (!cancelled) setDraftsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scopeKey, communityId]);

  const loadDraftImagesIfNeeded = useCallback(async (draftId: string) => {
    if (!draftId || loadedDraftImagesRef.current.has(draftId)) return;
    loadedDraftImagesRef.current.add(draftId);
    const images = await readComposeDraftImages(draftId);
    setDraftImagesById((prev) => ({ ...prev, [draftId]: images }));
  }, []);

  const activeDraft = useMemo(
    () => (activeDraftId ? drafts.find((draft) => draft.id === activeDraftId) : undefined),
    [drafts, activeDraftId],
  );
  const body = activeDraft ? activeDraft.body : freeformBody;
  const pendingImages = activeDraftId ? (draftImagesById[activeDraftId] ?? []) : freeformImages;
  const hasActiveDraft = activeDraftId !== "";

  const setBody = useCallback(
    (value: string) => {
      const next = clampPostContent(value);
      if (activeDraftId) {
        setDrafts((prev) =>
          prev.map((draft) => (draft.id === activeDraftId ? { ...draft, body: next } : draft)),
        );
        return;
      }
      setFreeformBody(next);
      writeComposeNeutralBodyCache(next, scopeKey);
    },
    [activeDraftId, scopeKey],
  );

  const setPendingImages = useCallback(
    (value: File[] | ((prev: File[]) => File[])) => {
      if (activeDraftIdRef.current) {
        const draftId = activeDraftIdRef.current;
        setDraftImagesById((prev) => {
          const current = prev[draftId] ?? [];
          const next = typeof value === "function" ? value(current) : value;
          return { ...prev, [draftId]: next };
        });
        return;
      }
      setFreeformImages((prev) => {
        const next = typeof value === "function" ? value(prev) : value;
        void writeComposeNeutralImages(scopeKey, next);
        return next;
      });
    },
    [scopeKey],
  );

  const mergePendingImages = useCallback((files: FileList | File[]) => {
    setPendingImages((prev) => mergePostImageFiles(prev, files));
  }, [setPendingImages]);

  const clearPendingImages = useCallback(() => {
    setPendingImages([]);
  }, [setPendingImages]);

  const filteredDrafts = useMemo(() => {
    const query = draftSearch.trim().toLowerCase();
    if (!query) return drafts;

    const matched = drafts.filter(
      (draft) =>
        draft.label.toLowerCase().includes(query) || draft.body.toLowerCase().includes(query),
    );
    if (matched.some((draft) => draft.id === activeDraftId)) return matched;

    const active = drafts.find((draft) => draft.id === activeDraftId);
    return active ? [active, ...matched] : matched;
  }, [drafts, draftSearch, activeDraftId]);

  const canAddDraft = drafts.length < COMPOSE_MAX_DRAFTS;
  const canDeleteDraft = drafts.length > 0;
  const trimmedBody = body.trim();
  const hasDraftTextChanges =
    hasActiveDraft && activeDraftId ? body !== (savedBodies[activeDraftId] ?? "") : false;
  const hasDraftImageChanges =
    hasActiveDraft && activeDraftId
      ? fingerprintComposeImages(pendingImages) !== (savedImageFingerprints[activeDraftId] ?? "")
      : false;
  const hasDraftChanges = hasDraftTextChanges || hasDraftImageChanges;
  const canSave = hasActiveDraft
    ? hasDraftChanges
    : (trimmedBody.length > 0 || pendingImages.length > 0) && canAddDraft;

  const createDraft = useCallback(
    async (initialBody = "", clearNeutral = false, initialImages: File[] = []) => {
      if (draftsRef.current.length >= COMPOSE_MAX_DRAFTS) return null;
      const created = await apiCreatePostDraft({ content: initialBody, communityId });
      const mapped = mapDraftDto(created);
      setDrafts((prev) => [mapped, ...prev]);
      setSavedBodies((prev) => ({ ...prev, [mapped.id]: mapped.body }));
      if (initialImages.length > 0) {
        setDraftImagesById((prev) => ({ ...prev, [mapped.id]: initialImages }));
        await writeComposeDraftImages(mapped.id, initialImages);
        setSavedImageFingerprints((prev) => ({
          ...prev,
          [mapped.id]: fingerprintComposeImages(initialImages),
        }));
      }
      setActiveDraftId(mapped.id);
      if (clearNeutral) {
        setFreeformBody("");
        setFreeformImages([]);
        clearComposeNeutralBodyCache(scopeKey);
        await clearComposeNeutralImages(scopeKey);
      }
      setDraftSearch("");
      return mapped.id;
    },
    [communityId, scopeKey],
  );

  const addDraft = useCallback(async () => {
    try {
      setDraftsError(null);
      await createDraft("");
    } catch (e) {
      setDraftsError(e instanceof Error ? e.message : "Не удалось создать черновик");
    }
  }, [createDraft]);

  const saveDraft = useCallback(async () => {
    if (trimmedBody.length === 0 && pendingImages.length === 0) return;
    try {
      setDraftsError(null);
      if (activeDraftId) {
        if (hasDraftTextChanges) {
          await flushDraftContent(activeDraftId, body);
        }
        if (hasDraftImageChanges) {
          await flushDraftImages(activeDraftId, pendingImages);
        }
        return;
      }
      if (draftsRef.current.length >= COMPOSE_MAX_DRAFTS) return;
      const imagesToSave = [...freeformImages];
      await createDraft(body, true, imagesToSave);
    } catch (e) {
      setDraftsError(e instanceof Error ? e.message : "Не удалось сохранить черновик");
    }
  }, [
    activeDraftId,
    body,
    createDraft,
    flushDraftContent,
    flushDraftImages,
    freeformImages,
    hasDraftImageChanges,
    hasDraftTextChanges,
    pendingImages,
    trimmedBody.length,
  ]);

  const editDraft = useCallback(async (id: string) => {
    const draft = draftsRef.current.find((item) => item.id === id);
    if (!draft) return;

    const nextLabelRaw = window.prompt(
      `Название черновика (до ${COMPOSE_DRAFT_LABEL_MAX_LEN} символов)`,
      draft.label,
    );
    if (nextLabelRaw === null) return;

    const nextLabel = normalizeComposeDraftLabel(nextLabelRaw);
    if (!nextLabel) return;

    try {
      setDraftsError(null);
      const updated = await apiUpdatePostDraft(id, { label: nextLabel });
      setDrafts((prev) => prev.map((item) => (item.id === id ? mapDraftDto(updated) : item)));
    } catch (e) {
      setDraftsError(e instanceof Error ? e.message : "Не удалось переименовать черновик");
    }
  }, []);

  const deleteDraft = useCallback(
    async (id: string) => {
      try {
        setDraftsError(null);
        await apiDeletePostDraft(id);
        await clearComposeDraftImages(id);
        setDrafts((prev) => prev.filter((item) => item.id !== id));
        setSavedBodies((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setSavedImageFingerprints((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setDraftImagesById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        if (activeDraftId === id) setActiveDraftId("");
      } catch (e) {
        setDraftsError(e instanceof Error ? e.message : "Не удалось удалить черновик");
      }
    },
    [activeDraftId],
  );

  const selectDraft = useCallback(
    (id: string) => {
      if (id === activeDraftId) return;
      setActiveDraftId(id);
      void loadDraftImagesIfNeeded(id);
    },
    [activeDraftId, loadDraftImagesIfNeeded],
  );

  const returnToNeutral = useCallback(() => {
    if (!activeDraftId) return;
    setActiveDraftId("");
  }, [activeDraftId]);

  const clearNeutralAfterPublish = useCallback(() => {
    setFreeformBody("");
    setFreeformImages([]);
    clearComposeNeutralBodyCache(scopeKey);
    void clearComposeNeutralImages(scopeKey);
  }, [scopeKey]);

  const removeDraftAfterPublish = useCallback(
    async (draftId: string) => {
      if (!draftId) return;
      try {
        await apiDeletePostDraft(draftId);
        await clearComposeDraftImages(draftId);
        setDrafts((prev) => prev.filter((item) => item.id !== draftId));
        setDraftImagesById((prev) => {
          const next = { ...prev };
          delete next[draftId];
          return next;
        });
        if (activeDraftId === draftId) setActiveDraftId("");
      } catch {
        /* пост уже опубликован — черновик можно удалить вручную */
      }
    },
    [activeDraftId],
  );

  return {
    drafts,
    filteredDrafts,
    draftsLoading,
    draftsError,
    activeDraftId,
    body,
    setBody,
    pendingImages,
    setPendingImages,
    mergePendingImages,
    clearPendingImages,
    hasActiveDraft,
    selectDraft,
    returnToNeutral,
    clearNeutralAfterPublish,
    draftSearch,
    setDraftSearch,
    canAddDraft,
    canDeleteDraft,
    canSave,
    addDraft,
    saveDraft,
    editDraft,
    deleteDraft,
    removeDraftAfterPublish,
  };
}
