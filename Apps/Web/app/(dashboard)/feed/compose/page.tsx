"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MessageComposeAttachMenu, type ComposeAttachKind } from "@/app/(dashboard)/messages/MessageComposeAttachMenu";
import { preloadMessageEmojiPicker } from "@/app/(dashboard)/messages/MessageEmojiPicker";
import { isFloraComposeStickerPanelTarget } from "@/app/_shared/floraRectMenuOverlay";
import { ComposeStickerPanel } from "./ComposeStickerPanel";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { formatAtHandle, profileDisplayName } from "@/app/_dashboard/userDisplay";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import { TabSearchInput } from "@/app/_shared/TabSearchInput";
import { FeedPostImages } from "@/app/_shared/FeedPostImages";
import {
  composePostImagePreviewId,
  extractPastedPostImages,
  useComposePostImagePreviews,
} from "@/lib/composePostImages";
import { normalizePostVideoFile, postVideoAttachError } from "@/lib/composePostVideo";
import { clampPostContent, MAX_POST_CONTENT_LENGTH } from "@/lib/postContentLimits";
import { invalidateFeedCaches, invalidateProfileCache } from "@/lib/dashboardPreload";
import { apiCreatePost, apiUploadPostImages, apiUploadPostVideo, type OwnedCommunityDto } from "@/lib/socialApi";
import { ComposeDraftsSidebar } from "./ComposeDraftsSidebar";
import { ComposeEmojiStickerIcon } from "./ComposeEmojiStickerPanel";
// import { ComposeRichTextEditor, type ComposeRichTextEditorHandle } from "./ComposeRichTextEditor";
import styles from "./compose.module.css";
import { pickRandomComposeBodyPlaceholder } from "./composeBodyPlaceholders";
// import type { ComposeFormatId } from "./composeTextFormat";
import { useComposeStickerPanel } from "./useComposeStickerPanel";
import { useComposePostFieldHeight } from "./useComposePostFieldHeight";
import {
  COMPOSE_COMMUNITY_MODE_PREFIX,
  COMPOSE_MODE_EXTRA,
  COMPOSE_PROFILE_MODE_ID,
  composeCommunityModeId,
  composeModeToDraftScope,
  isComposeCommunityModeId,
  isComposeModeId,
} from "./composeModes";
import { useComposeOwnedCommunities } from "./useComposeOwnedCommunities";
import { useComposePostDrafts } from "./useComposePostDrafts";

function communityHandle(slug: string): string {
  const trimmed = slug.trim();
  return trimmed ? `@${trimmed}` : "@community";
}

/* Форматирование поста — отложено до лучших времён.
type ComposeTool = {
  id: string;
  label: string;
  col: number;
};

const MAIN_TOOLS: ComposeTool[] = [
  { id: "bold", label: "Жирный", col: 42 },
  { id: "italic", label: "Курсив", col: 45 },
  { id: "underline", label: "Подчеркнутый", col: 48 },
  { id: "strikethrough", label: "Зачеркнутый", col: 51 },
  { id: "mono", label: "Моноширинный", col: 54 },
  { id: "spoiler", label: "Спойлер", col: 57 },
  { id: "link", label: "Гиперссылка", col: 60 },
  { id: "mention", label: "Упоминание", col: 63 },
  { id: "more", label: "Дополнительно", col: 66 }
];
*/

const COMPOSE_STICKER_PANEL_ID = "compose-sticker-panel";

type ComposeTabIndicatorStyle = CSSProperties &
  Record<"--compose-tab-indicator-left" | "--compose-tab-indicator-width", string>;

/* Форматирование поста — отложено до лучших времён.
function ToolIcon({ id }: { id: string }) {
  switch (id) {
    case "bold":
      return (
        <span className={styles.composeToolLetterB} aria-hidden>
          B
        </span>
      );
    case "italic":
      return (
        <svg viewBox="0 0 24 24" aria-hidden className={styles.composeToolIconItalicLg}>
          <path d="M9 6h8M7 19h8M13 6L11 19" />
        </svg>
      );
    case "underline":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M7 4v7a5 5 0 0 0 10 0V4" />
          <path d="M5 20h14" />
        </svg>
      );
    case "strikethrough":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M6 7.5a4.5 4.5 0 0 1 4.5-3.5h3A4.5 4.5 0 0 1 18 8.5" />
          <path d="M6 16.5A4.5 4.5 0 0 0 10.5 20h3a4.5 4.5 0 0 0 4.5-4.5" />
          <path d="M3 12h18" />
        </svg>
      );
    case "mono":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 9h8M8 12h8M8 15h5" />
        </svg>
      );
    case "spoiler":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z" />
          <path d="M3.5 20L20.5 4" />
        </svg>
      );
    case "link":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M10 14l4-4" />
          <path d="M8 16H6a4 4 0 1 1 0-8h2" />
          <path d="M16 8h2a4 4 0 1 1 0 8h-2" />
        </svg>
      );
    case "mention":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M16.5 12v2.5a2.5 2.5 0 0 0 5 0V12a9.5 9.5 0 1 0-3.1 7" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "more":
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <circle cx="6" cy="12" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="18" cy="12" r="1.5" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M14 3h7v7" />
          <path d="M10 14L21 3" />
          <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
        </svg>
      );
  }
}
*/

function ComposePostPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { me, loading } = useCurrentUser();
  const [bodyPlaceholder] = useState(pickRandomComposeBodyPlaceholder);
  const [submitting, setSubmitting] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  /* Видео к посту: одно на пост (v1), сервер транскодирует в AV1 фоном. */
  const [pendingVideo, setPendingVideo] = useState<File | null>(null);
  const pendingVideoUrl = useMemo(() => (pendingVideo ? URL.createObjectURL(pendingVideo) : null), [pendingVideo]);
  useEffect(
    () => () => {
      if (pendingVideoUrl) URL.revokeObjectURL(pendingVideoUrl);
    },
    [pendingVideoUrl]
  );
  const [activeComposeMode, setActiveComposeMode] = useState(() => {
    const mode = searchParams.get("mode");
    return mode && isComposeModeId(mode) ? mode : COMPOSE_PROFILE_MODE_ID;
  });
  const [indicatorVars, setIndicatorVars] = useState<ComposeTabIndicatorStyle>({
    "--compose-tab-indicator-left": "0px",
    "--compose-tab-indicator-width": "0px",
  });
  const [indicatorMotionEnabled, setIndicatorMotionEnabled] = useState(false);
  const indicatorMotionPrimedRef = useRef(false);
  const composeTabsRef = useRef<HTMLDivElement | null>(null);
  const composeTabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composeScrollRef = useRef<HTMLDivElement | null>(null);
  const composeSurfaceRef = useRef<HTMLDivElement | null>(null);
  const composeFieldWrapRef = useRef<HTMLDivElement | null>(null);
  const stickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  /** После первого кадра — fade при смене вкладки, черновика или нейтрального поста. */
  const composeDraftScopePrimedRef = useRef(false);
  const [attachMenuCloseNonce, setAttachMenuCloseNonce] = useState(0);
  // const [activeFormats, setActiveFormats] = useState<ComposeFormatId[]>([]);

  const requestCloseAttachMenu = useCallback(() => {
    setAttachMenuCloseNonce((nonce) => nonce + 1);
  }, []);

  const stickerPanel = useComposeStickerPanel(requestCloseAttachMenu);
  const { communities: ownedCommunities, loading: ownedCommunitiesLoading } = useComposeOwnedCommunities();

  const {
    filteredDrafts,
    draftsError,
    activeDraftId,
    body,
    setBody,
    draftSearch,
    setDraftSearch,
    canAddDraft,
    canDeleteDraft,
    canSave,
    addDraft,
    saveDraft,
    editDraft,
    deleteDraft,
    selectDraft,
    returnToNeutral,
    clearNeutralAfterPublish,
    removeDraftAfterPublish,
    pendingImages,
    setPendingImages,
    mergePendingImages,
    clearPendingImages,
  } = useComposePostDrafts(activeComposeMode);
  const pendingImagePreviews = useComposePostImagePreviews(pendingImages);

  const { style: composeFieldStyle, visibleRows: composeVisibleRows } = useComposePostFieldHeight(
    textareaRef,
    body,
    composeScrollRef,
    pendingImagePreviews.map((p) => p.id).join("|"),
  );

  useEffect(() => {
    composeDraftScopePrimedRef.current = true;
  }, []);

  const composeEditorScopeKey = useMemo(
    () => `${activeComposeMode}:${activeDraftId || "neutral"}`,
    [activeComposeMode, activeDraftId],
  );

  const trimmed = body.trim();
  const canPublish =
    (trimmed.length > 0 || pendingImages.length > 0 || pendingVideo !== null) &&
    trimmed.length <= MAX_POST_CONTENT_LENGTH;
  const canClearBody = body.length > 0 || pendingImages.length > 0 || pendingVideo !== null;

  const profileDisplayNameValue = me ? profileDisplayName(me.displayName, me.username) : loading ? "…" : "Профиль";
  const profileHandle = me ? formatAtHandle(me.username) : loading ? "…" : "@…";

  const ownedCommunityModes = useMemo(
    () =>
      ownedCommunities.map((community) => ({
        id: composeCommunityModeId(community.communityId),
        label: community.name,
        community,
      })),
    [ownedCommunities],
  );

  const composeModes = useMemo(
    () => [
      { id: COMPOSE_PROFILE_MODE_ID, label: profileDisplayNameValue },
      ...ownedCommunityModes.map(({ id, label }) => ({ id, label })),
      ...COMPOSE_MODE_EXTRA,
    ],
    [ownedCommunityModes, profileDisplayNameValue],
  );

  const activeOwnedCommunity = useMemo((): OwnedCommunityDto | undefined => {
    if (!isComposeCommunityModeId(activeComposeMode)) return undefined;
    const communityId = activeComposeMode.slice(COMPOSE_COMMUNITY_MODE_PREFIX.length).trim();
    return ownedCommunities.find((c) => c.communityId === communityId);
  }, [activeComposeMode, ownedCommunities]);

  const editorDisplayName = activeOwnedCommunity?.name ?? profileDisplayNameValue;
  const editorHandle = activeOwnedCommunity ? communityHandle(activeOwnedCommunity.slug) : profileHandle;
  const editorAvatarUuid = activeOwnedCommunity?.avatarUuid ?? me?.avatarUuid ?? null;
  const editorAvatarSeed = activeOwnedCommunity?.communityId ?? me?.userUuid ?? me?.username ?? "";
  const editorCommunityName = activeOwnedCommunity?.name;

  const publishCommunityId = composeModeToDraftScope(activeComposeMode).communityId;

  useEffect(() => {
    const mode = searchParams.get("mode");
    if (mode && isComposeModeId(mode)) {
      setActiveComposeMode(mode);
    }
  }, [searchParams]);

  useEffect(() => {
    if (activeComposeMode === COMPOSE_PROFILE_MODE_ID || ownedCommunitiesLoading) return;
    if (!isComposeCommunityModeId(activeComposeMode)) return;
    const communityId = activeComposeMode.slice(COMPOSE_COMMUNITY_MODE_PREFIX.length).trim();
    if (ownedCommunities.some((c) => c.communityId === communityId)) return;
    setActiveComposeMode(COMPOSE_PROFILE_MODE_ID);
  }, [activeComposeMode, ownedCommunities, ownedCommunitiesLoading]);

  useEffect(() => {
    preloadMessageEmojiPicker();
  }, []);

  const {
    rendered: stickerPanelRendered,
    closing: stickerPanelClosing,
    requestClose: requestCloseStickerPanel,
    toggle: toggleStickerPanel,
    open: stickerPanelOpen,
  } = stickerPanel;

  const clearBody = useCallback(() => {
    setBody("");
    clearPendingImages();
    setPendingVideo(null);
    requestCloseStickerPanel();
    requestCloseAttachMenu();
    textareaRef.current?.focus();
  }, [clearPendingImages, requestCloseAttachMenu, requestCloseStickerPanel, setBody]);

  const handleAttachPick = useCallback((kind: ComposeAttachKind, files: FileList) => {
    if (kind === "photo") {
      mergePendingImages(files);
      return;
    }
    if (kind === "video") {
      const raw = files[0];
      if (!raw) return;
      const normalized = normalizePostVideoFile(raw);
      if (!normalized) {
        setPublishError(postVideoAttachError(raw));
        return;
      }
      setPublishError(null);
      setPendingVideo(normalized);
      return;
    }
    /* Музыка — позже */
  }, [mergePendingImages]);

  const handleComposePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const images = extractPastedPostImages(event.clipboardData);
      if (images.length === 0) return;
      event.preventDefault();
      mergePendingImages(images);
    },
    [mergePendingImages],
  );

  const removePendingImage = useCallback(
    (previewId: string) => {
      setPendingImages((prev) =>
        prev.filter((file, index) => composePostImagePreviewId(file, index) !== previewId),
      );
    },
    [setPendingImages],
  );

  useEffect(() => {
    if (!stickerPanelRendered || stickerPanelClosing) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (isFloraComposeStickerPanelTarget(event.target)) return;
      const surface = composeSurfaceRef.current;
      if (surface && event.target instanceof Node && surface.contains(event.target)) return;
      requestCloseStickerPanel();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      requestCloseStickerPanel();
      textareaRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [stickerPanelRendered, stickerPanelClosing, requestCloseStickerPanel]);

  /* Форматирование поста — отложено до лучших времён.
  const handleFormatTool = useCallback((formatId: ComposeFormatId) => {
    editorRef.current?.applyFormat(formatId);
  }, []);
  */

  const insertComposeToken = useCallback(
    (value: string) => {
      const input = textareaRef.current;
      const selectionStart = input?.selectionStart ?? body.length;
      const selectionEnd = input?.selectionEnd ?? body.length;
      const nextText = clampPostContent(
        `${body.slice(0, selectionStart)}${value}${body.slice(selectionEnd)}`,
      );
      const caret = Math.min(selectionStart + value.length, nextText.length);
      setBody(nextText);
      window.requestAnimationFrame(() => {
        if (!input) return;
        input.focus();
        input.setSelectionRange(caret, caret);
      });
    },
    [body],
  );

  useLayoutEffect(() => {
    const target = composeTabRefs.current[activeComposeMode];
    if (!target) return;
    const left = target.offsetLeft;
    const tabW = target.offsetWidth;
    if (tabW <= 0) return;
    setIndicatorVars({
      "--compose-tab-indicator-left": `${left}px`,
      "--compose-tab-indicator-width": `${tabW}px`,
    });
  }, [activeComposeMode, composeModes]);

  useEffect(() => {
    const syncIndicator = () => {
      const target = composeTabRefs.current[activeComposeMode];
      if (!target) return;
      const left = target.offsetLeft;
      const tabW = target.offsetWidth;
      if (tabW <= 0) return;
      setIndicatorVars({
        "--compose-tab-indicator-left": `${left}px`,
        "--compose-tab-indicator-width": `${tabW}px`,
      });
      if (!indicatorMotionPrimedRef.current) {
        indicatorMotionPrimedRef.current = true;
        requestAnimationFrame(() => setIndicatorMotionEnabled(true));
      }
    };

    syncIndicator();

    const row = composeTabsRef.current;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncIndicator) : null;
    if (ro) {
      if (row) ro.observe(row);
      const target = composeTabRefs.current[activeComposeMode];
      if (target) ro.observe(target);
    }

    const onScroll = () => syncIndicator();
    row?.addEventListener("scroll", onScroll, { passive: true });

    window.addEventListener("resize", syncIndicator);
    void document.fonts?.ready.then(syncIndicator);

    return () => {
      window.removeEventListener("resize", syncIndicator);
      row?.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [activeComposeMode, composeModes, ownedCommunities.length, profileDisplayNameValue]);

  const publish = async () => {
    if (!canPublish || submitting) return;
    setPublishError(null);
    setSubmitting(true);
    const publishedFromDraftId = activeDraftId;
    const publishedFromNeutral = !activeDraftId;
    const imagesToUpload = [...pendingImages];
    const videoToUpload = pendingVideo;
    try {
      const { postUuid } = await apiCreatePost(trimmed, { communityId: publishCommunityId });
      if (imagesToUpload.length > 0) {
        try {
          await apiUploadPostImages(postUuid, imagesToUpload);
        } catch (uploadErr) {
          const detail =
            uploadErr instanceof Error ? uploadErr.message : "Не удалось загрузить фото";
          setPublishError(`Пост создан, но фото не загружены: ${detail}`);
          await removeDraftAfterPublish(publishedFromDraftId);
          if (publishedFromNeutral) clearNeutralAfterPublish();
          return;
        }
      }
      if (videoToUpload) {
        try {
          await apiUploadPostVideo(postUuid, videoToUpload);
        } catch (uploadErr) {
          const detail =
            uploadErr instanceof Error ? uploadErr.message : "Не удалось загрузить видео";
          setPublishError(`Пост создан, но видео не загружено: ${detail}`);
          await removeDraftAfterPublish(publishedFromDraftId);
          if (publishedFromNeutral) clearNeutralAfterPublish();
          return;
        }
      }
      setPendingVideo(null);
      invalidateFeedCaches();
      if (me?.username) {
        invalidateProfileCache(me.username);
      }
      await removeDraftAfterPublish(publishedFromDraftId);
      if (publishedFromNeutral) clearNeutralAfterPublish();
      router.push("/feed");
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : "Не удалось опубликовать пост");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className={styles.composePage} id="central-scroll-compose">
        <div className={styles.composeTopBlock}>
          <div className={styles.composeTopBlockInner}>
            <div className={styles.composeSearchHeader}>
              <TabSearchInput
                placeholder="Поиск по тексту"
                value={draftSearch}
                onChange={setDraftSearch}
                showActionButton={false}
                classNames={{
                  wrap: styles.composeSearchWrap,
                  box: styles.composeSearchBox,
                  icon: styles.composeSearchIcon,
                  input: styles.composeSearchInput,
                }}
              />
            </div>

            <div className={styles.composeTabsBlock}>
              <div className={styles.composeTabsWrap}>
                <div
                  ref={composeTabsRef}
                  className={styles.composeTabs}
                  role="tablist"
                  aria-label="Режимы публикации"
                >
                  {composeModes.map((mode) => (
                    <button
                      key={mode.id}
                      ref={(node) => {
                        composeTabRefs.current[mode.id] = node;
                      }}
                      type="button"
                      role="tab"
                      aria-selected={activeComposeMode === mode.id}
                      className={`${styles.composeTab} flora-type-15 ${activeComposeMode === mode.id ? styles.composeTabActive : ""}`}
                      onClick={() => setActiveComposeMode(mode.id)}
                    >
                      <span className={styles.composeTabLabel}>{mode.label}</span>
                    </button>
                  ))}
                </div>
                <div
                  className={`${styles.composeTabIndicator} ${!indicatorMotionEnabled ? styles.composeTabIndicatorStatic : ""}`}
                  style={indicatorVars}
                  aria-hidden
                />
              </div>
            </div>
          </div>
        </div>

        <div className={styles.composeMainColumn}>
          <div ref={composeScrollRef} className={styles.composeScroll}>
          <div className={styles.composeEditor}>
            <div
              key={composeEditorScopeKey}
              className={`${styles.composeDraftScope}${composeDraftScopePrimedRef.current ? ` ${styles.composeDraftScopeIn}` : ""}`}
            >
            <FloraAvatar
              avatarUuid={editorAvatarUuid}
              displayName={editorDisplayName}
              username={activeOwnedCommunity ? activeOwnedCommunity.slug : me?.username ?? ""}
              seed={editorAvatarSeed}
              communityName={editorCommunityName}
              className={styles.composeAvatar}
            />
            <header className={styles.composeHeader}>
              <div className={styles.composeIdentity}>
                <span className={`${styles.composeDisplayName} flora-type-15`}>{editorDisplayName}</span>
                <span className={`${styles.composeHandle} flora-type-15`}>{editorHandle}</span>
              </div>
            </header>
            <div className={styles.composeBody}>
              <div ref={composeSurfaceRef} className={styles.composeBodyStack} style={composeFieldStyle}>
                {publishError ? (
                  <p className={styles.composePublishError} role="alert">
                    {publishError}
                  </p>
                ) : null}
                {draftsError ? (
                  <p className={styles.composePublishError} role="alert">
                    {draftsError}
                  </p>
                ) : null}
                <div ref={composeFieldWrapRef} className={styles.composeFieldWrap}>
                  <textarea
                    ref={textareaRef}
                    className={`${styles.composePostInput} flora-type-15`}
                    aria-label="Текст поста"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onPaste={handleComposePaste}
                    placeholder={bodyPlaceholder}
                    maxLength={MAX_POST_CONTENT_LENGTH}
                    rows={1}
                    spellCheck={false}
                  />
                </div>
                {pendingImagePreviews.length > 0 ? (
                  <FeedPostImages
                    previewItems={pendingImagePreviews}
                    onRemovePreview={removePendingImage}
                    className={styles.composePostImages}
                  />
                ) : null}
                {pendingVideoUrl ? (
                  <div className={styles.composePostVideoWrap}>
                    {/* Превью локального файла; AV1-версия появится после публикации. */}
                    <video className={styles.composePostVideo} src={pendingVideoUrl} controls playsInline preload="metadata" />
                    <button
                      type="button"
                      className={styles.composePostVideoRemove}
                      aria-label="Убрать видео"
                      onClick={() => setPendingVideo(null)}
                    >
                      ×
                    </button>
                  </div>
                ) : null}
                <hr className={styles.composeFieldDivider} aria-hidden />
                {/* Форматирование поста — отложено до лучших времён.
                <ComposeRichTextEditor
                  ref={editorRef}
                  aria-label="Текст поста"
                  value={body}
                  onChange={setBody}
                  onActiveFormatsChange={setActiveFormats}
                  placeholder={bodyPlaceholder}
                  maxLength={MAX_POST_CONTENT_LENGTH}
                />
                */}
                <div className={styles.composeActions}>
                  <button
                    type="button"
                    className={styles.composeClearAllBtn}
                    disabled={!canClearBody}
                    onClick={clearBody}
                    aria-label="Стереть все"
                  >
                    Стереть все
                    <svg
                      className={styles.composeClearAllBtnIcon}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      aria-hidden
                    >
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                  {/* {MAIN_TOOLS.map((tool) => {
                    const formatId = tool.id as ComposeFormatId;
                    const isFormatTool = tool.id !== "more";
                    const isActive = isFormatTool && activeFormats.includes(formatId);

                    return (
                      <button
                        key={tool.id}
                        type="button"
                        className={`${styles.composeToolBtn} ${styles.composeToolBtnMain} ${isActive ? styles.composeToolBtnActive : ""}`}
                        style={{ "--compose-tool-col": tool.col } as CSSProperties}
                        aria-label={tool.label}
                        title={tool.label}
                        aria-pressed={isFormatTool ? isActive : undefined}
                        onMouseDown={(e) => {
                          e.preventDefault();
                        }}
                        onClick={() => {
                          if (tool.id === "more") return;
                          handleFormatTool(formatId);
                        }}
                      >
                        <ToolIcon id={tool.id} />
                      </button>
                    );
                  })} */}
                  <div className={styles.composeActionsTrailing}>
                    <div className={styles.composeActionsLeading}>
                      <button
                        ref={stickerTriggerRef}
                        type="button"
                        className={`${styles.composeToolBtn} ${styles.composeToolBtnAttach}`}
                        aria-label="Стикеры и эмодзи"
                        title="Стикеры и эмодзи"
                        aria-controls={COMPOSE_STICKER_PANEL_ID}
                        aria-expanded={stickerPanelRendered && stickerPanelOpen}
                        onClick={toggleStickerPanel}
                      >
                        <ComposeEmojiStickerIcon />
                      </button>
                      <MessageComposeAttachMenu
                        wrapClassName={styles.composeAttachWrap}
                        buttonClassName={styles.composeAttachTrigger}
                        triggerVariant="paperclip"
                        fieldAnchorRef={composeFieldWrapRef}
                        visibleRows={composeVisibleRows}
                        closeNonce={attachMenuCloseNonce}
                        onOpenChange={(open) => {
                          if (open && stickerPanelRendered) requestCloseStickerPanel();
                        }}
                        onPick={handleAttachPick}
                      />
                    </div>
                    <button
                      type="button"
                      className={`flora-grid-action-btn ${styles.saveBtn}`}
                      disabled={!canSave}
                      onClick={() => void saveDraft()}
                    >
                      Сохранить
                    </button>
                    <button
                      type="button"
                      className={`flora-grid-action-btn ${styles.publishBtn}`}
                      disabled={!canPublish || submitting}
                      onClick={() => void publish()}
                    >
                      {submitting ? "Публикация…" : "Опубликовать"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            </div>
          </div>
        </div>
      </div>
      <ComposeDraftsSidebar
        composeScopeId={activeComposeMode}
        drafts={filteredDrafts}
        activeDraftId={activeDraftId}
        canAddDraft={canAddDraft}
        canDeleteDraft={canDeleteDraft}
        onDraftSelect={selectDraft}
        onAddDraft={() => void addDraft()}
        onReturnToNeutral={returnToNeutral}
        onEditDraft={(id) => void editDraft(id)}
        onDeleteDraft={(id) => void deleteDraft(id)}
      />
      <ComposeStickerPanel
        panelId={COMPOSE_STICKER_PANEL_ID}
        triggerRef={stickerTriggerRef}
        alignSurfaceRef={composeSurfaceRef}
        fieldAnchorRef={composeFieldWrapRef}
        visibleRows={composeVisibleRows}
        rendered={stickerPanelRendered}
        open={stickerPanelOpen}
        closing={stickerPanelClosing}
        tab={stickerPanel.tab}
        tabTransition={stickerPanel.tabTransition}
        tabAnimEpoch={stickerPanel.tabAnimEpoch}
        onPickEmoji={insertComposeToken}
        onSelectTab={stickerPanel.selectTab}
      />
    </section>
  );
}

export default function ComposePostPage() {
  const { isClient, hasToken } = useProtectedPage();

  if (!isClient || !hasToken) return <div className={styles.composePage} />;

  return <ComposePostPageContent />;
}
