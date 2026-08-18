import { Ionicons } from "@expo/vector-icons";
import {
  apiCreatePost,
  apiCreatePostDraft,
  apiDeletePostDraft,
  apiGetOwnedCommunities,
  apiUpdatePostDraft,
  isApiRequestError,
} from "@flora/client-core/api";
import type { CommunityListItemDto, PostDraftDto } from "@flora/client-core/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ComposeDraftsSheet } from "@/components/compose/ComposeDraftsSheet";
import { ComposeModeTabs } from "@/components/compose/ComposeModeTabs";
import { ComposePostCard } from "@/components/compose/ComposePostCard";
import { ComposeToolbar } from "@/components/compose/ComposeToolbar";
import { DropdownMenuOverlay } from "@/components/DropdownMenuOverlay";
import { ChatMessageEmojiPanel } from "@/components/messages/ChatMessageEmojiPanel";
import {
  COMPOSE_PROFILE_MODE_ID,
  MAX_POST_CONTENT_LENGTH,
  clampPostContent,
  composeCommunityModeId,
  composeModeCommunityId,
  pickRandomComposeBodyPlaceholder,
} from "@/lib/compose/composeModes";
import { uploadPostImagesNative, uploadPostVideoNative } from "@/lib/compose/postMediaUpload";
import { useComposePostMedia } from "@/lib/compose/useComposePostMedia";
import { useSessionStore } from "@/stores/sessionStore";
import {
  floraColors,
  floraMessages,
  floraSpacing,
  floraTabBarContentPadding,
} from "@/lib/theme";

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function FeedComposeScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const me = useSessionStore((s) => s.me);
  const params = useLocalSearchParams<{ communityUuid?: string | string[] }>();
  const initialCommunityUuid = routeParam(params.communityUuid);

  const [modeId, setModeId] = useState(() =>
    initialCommunityUuid ? composeCommunityModeId(initialCommunityUuid) : COMPOSE_PROFILE_MODE_ID,
  );
  const [text, setText] = useState("");
  const [placeholder] = useState(() => pickRandomComposeBodyPlaceholder());
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [activeDraftUuid, setActiveDraftUuid] = useState<string | null>(null);
  const [activeDraftLabel, setActiveDraftLabel] = useState("");
  const inputRef = useRef<TextInput>(null);
  const headerMoreRef = useRef<View>(null);
  const selectionRef = useRef({ start: 0, end: 0 });

  const media = useComposePostMedia();
  const communityId = composeModeCommunityId(modeId);

  const ownedQuery = useQuery({
    queryKey: ["communities", "owned"],
    queryFn: apiGetOwnedCommunities,
  });

  useEffect(() => {
    if (!initialCommunityUuid) return;
    setModeId(composeCommunityModeId(initialCommunityUuid));
  }, [initialCommunityUuid]);

  const modeTabs = useMemo(() => {
    const tabs = [{ id: COMPOSE_PROFILE_MODE_ID, modeId: COMPOSE_PROFILE_MODE_ID, label: "Профиль" }];
    for (const c of ownedQuery.data ?? []) {
      const modeId = composeCommunityModeId(c.communityId);
      tabs.push({ id: modeId, modeId, label: c.name });
    }
    return tabs;
  }, [ownedQuery.data]);

  const draftGroups = useMemo(
    () => modeTabs.map(({ modeId, label }) => ({ modeId, label })),
    [modeTabs],
  );

  const activeCommunity: CommunityListItemDto | null = useMemo(() => {
    if (!communityId) return null;
    return (ownedQuery.data ?? []).find((c) => c.communityId === communityId) ?? null;
  }, [communityId, ownedQuery.data]);

  // Как на Web: в режиме сообщества не подставляем аватар профиля.
  const authorAvatar = activeCommunity
    ? activeCommunity.avatarUuid?.trim() || null
    : (me?.avatarUuid ?? null);

  const canPublish =
    (text.trim().length > 0 || media.readyImageFiles.length > 0 || media.videoFile != null) &&
    !media.hasPendingPrepare &&
    !publishing;

  const canSaveDraft = text.trim().length > 0 || activeDraftUuid != null;

  const onChangeText = useCallback((value: string) => {
    setText(clampPostContent(value));
    setError(null);
  }, []);

  const insertEmoji = useCallback((emoji: string) => {
    setText((prev) => {
      const { start, end } = selectionRef.current;
      const next = clampPostContent(prev.slice(0, start) + emoji + prev.slice(end));
      const cursor = Math.min(start + emoji.length, next.length);
      selectionRef.current = { start: cursor, end: cursor };
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setText("");
    media.clearMedia();
    setError(null);
  }, [media]);

  const switchMode = useCallback(
    (nextId: string) => {
      if (nextId === modeId) return;
      setModeId(nextId);
      setActiveDraftUuid(null);
      setActiveDraftLabel("");
      setText("");
      media.clearMedia();
      setError(null);
      setEmojiOpen(false);
    },
    [media, modeId],
  );

  const onPublish = useCallback(async () => {
    if (!canPublish) return;
    setPublishing(true);
    setError(null);
    try {
      const { postUuid } = await apiCreatePost({
        content: text.trim(),
        communityId: communityId ?? null,
      });
      if (media.readyImageFiles.length > 0) {
        await uploadPostImagesNative(postUuid, media.readyImageFiles);
      }
      if (media.videoFile) {
        await uploadPostVideoNative(postUuid, media.videoFile);
      }
      if (activeDraftUuid) {
        try {
          await apiDeletePostDraft(activeDraftUuid);
        } catch {
          /* черновик мог быть уже удалён */
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["feed"] });
      await queryClient.invalidateQueries({ queryKey: ["post-drafts"] });
      router.back();
    } catch (e) {
      setError(isApiRequestError(e) ? e.message : "Не удалось опубликовать");
    } finally {
      setPublishing(false);
    }
  }, [activeDraftUuid, canPublish, communityId, media.readyImageFiles, media.videoFile, queryClient, text]);

  const onSaveDraft = useCallback(async () => {
    if (!canSaveDraft || savingDraft) return;
    setSavingDraft(true);
    setError(null);
    try {
      if (activeDraftUuid) {
        await apiUpdatePostDraft(activeDraftUuid, { content: text });
      } else {
        const created = await apiCreatePostDraft({
          content: text,
          communityId,
        });
        setActiveDraftUuid(created.draftUuid);
        setActiveDraftLabel(created.label);
      }
      await queryClient.invalidateQueries({ queryKey: ["post-drafts"] });
    } catch (e) {
      setError(isApiRequestError(e) ? e.message : "Не удалось сохранить черновик");
    } finally {
      setSavingDraft(false);
    }
  }, [activeDraftUuid, canSaveDraft, communityId, queryClient, savingDraft, text]);

  const onSelectDraft = useCallback(
    (draft: PostDraftDto, scopeModeId: string) => {
      if (scopeModeId !== modeId) {
        setModeId(scopeModeId);
      }
      setActiveDraftUuid(draft.draftUuid);
      setActiveDraftLabel(draft.label);
      setText(clampPostContent(draft.content));
      media.clearMedia();
      setDraftsOpen(false);
      setError(null);
    },
    [media, modeId],
  );

  const onCreateDraft = useCallback(
    async (scopeModeId: string) => {
      const scopeCommunityId = composeModeCommunityId(scopeModeId);
      const sameScope = scopeModeId === modeId;
      try {
        if (!sameScope) {
          setModeId(scopeModeId);
          setText("");
          media.clearMedia();
          setActiveDraftUuid(null);
          setActiveDraftLabel("");
        }
        const created = await apiCreatePostDraft({
          content: sameScope ? text : "",
          communityId: scopeCommunityId,
        });
        setActiveDraftUuid(created.draftUuid);
        setActiveDraftLabel(created.label);
        await queryClient.invalidateQueries({ queryKey: ["post-drafts"] });
      } catch (e) {
        setError(isApiRequestError(e) ? e.message : "Не удалось создать черновик");
      }
    },
    [media, modeId, queryClient, text],
  );

  const onRenameDraft = useCallback(
    async (draft: PostDraftDto, label: string) => {
      try {
        await apiUpdatePostDraft(draft.draftUuid, { label });
        if (activeDraftUuid === draft.draftUuid) {
          setActiveDraftLabel(label);
        }
        await queryClient.invalidateQueries({ queryKey: ["post-drafts"] });
      } catch (e) {
        setError(isApiRequestError(e) ? e.message : "Не удалось переименовать");
      }
    },
    [activeDraftUuid, queryClient],
  );

  const onDeleteDraft = useCallback(
    async (draft: PostDraftDto) => {
      try {
        await apiDeletePostDraft(draft.draftUuid);
        if (activeDraftUuid === draft.draftUuid) {
          setActiveDraftUuid(null);
          setActiveDraftLabel("");
          setText("");
          media.clearMedia();
        }
        await queryClient.invalidateQueries({ queryKey: ["post-drafts"] });
      } catch (e) {
        setError(isApiRequestError(e) ? e.message : "Не удалось удалить черновик");
      }
    },
    [activeDraftUuid, media, queryClient],
  );

  const pickPhoto = useCallback(async () => {
    const err = await media.pickImages();
    if (err) setError(err);
  }, [media]);

  const pickVideo = useCallback(async () => {
    const err = await media.pickVideo();
    if (err) setError(err);
  }, [media]);

  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));
  const title = activeDraftUuid
    ? activeDraftLabel.trim() || "Без названия"
    : "Новый пост";

  return (
    <View style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
          <View style={styles.chromeRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Назад"
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
              onPress={() => router.back()}
            >
              <Ionicons name="chevron-back" size={24} color={floraColors.gray} />
            </Pressable>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <View style={styles.spacer} />
            <View ref={headerMoreRef} collapsable={false}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Меню"
                accessibilityState={{ expanded: headerMenuOpen }}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                onPress={() => setHeaderMenuOpen(true)}
              >
                <Ionicons name="ellipsis-vertical" size={22} color={floraColors.gray} />
              </Pressable>
            </View>
          </View>
          <ComposeModeTabs tabs={modeTabs} activeId={modeId} onSelect={switchMode} />
        </View>

        <DropdownMenuOverlay
          open={headerMenuOpen}
          onClose={() => setHeaderMenuOpen(false)}
          anchorRef={headerMoreRef}
          menuStyle={styles.headerMenu}
          alignEnd
        >
          <Pressable
            accessibilityRole="menuitem"
            style={({ pressed }) => [styles.headerMenuItem, pressed && styles.pressed]}
            onPress={() => {
              setHeaderMenuOpen(false);
              setDraftsOpen(true);
            }}
          >
            <Ionicons name="documents-outline" size={18} color={floraColors.gray} />
            <Text style={styles.headerMenuLabel}>Черновики</Text>
          </Pressable>
          <Pressable
            accessibilityRole="menuitem"
            style={({ pressed }) => [styles.headerMenuItem, pressed && styles.pressed]}
            onPress={() => {
              setHeaderMenuOpen(false);
              void onSaveDraft();
            }}
          >
            <Ionicons name="save-outline" size={18} color={floraColors.gray} />
            <Text style={styles.headerMenuLabel}>Сохранить</Text>
          </Pressable>
          <Pressable
            accessibilityRole="menuitem"
            style={({ pressed }) => [styles.headerMenuItem, pressed && styles.pressed]}
            onPress={() => {
              setHeaderMenuOpen(false);
              clearAll();
            }}
          >
            <Ionicons name="trash-outline" size={18} color={floraColors.gray} />
            <Text style={styles.headerMenuLabel}>Очистить</Text>
          </Pressable>
        </DropdownMenuOverlay>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.editorScroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <ComposePostCard
            displayName={activeCommunity?.name ?? me?.displayName ?? "Вы"}
            username={activeCommunity ? activeCommunity.slug : me?.username}
            avatarUuid={authorAvatar}
            communityName={activeCommunity?.name}
            seed={activeCommunity?.communityId ?? me?.userUuid}
            showHandle={!activeCommunity}
            accountBlocked={me?.accountBlocked}
            text={text}
            placeholder={placeholder}
            maxLength={MAX_POST_CONTENT_LENGTH}
            error={error}
            images={media.images}
            video={media.video}
            inputRef={inputRef}
            onChangeText={onChangeText}
            onSelectionChange={(start, end) => {
              selectionRef.current = { start, end };
            }}
            onRemoveImage={media.removeImageAt}
            onRemoveVideo={media.clearVideo}
          />
        </ScrollView>

        <View style={{ paddingBottom: listPaddingBottom }}>
          <ComposeToolbar
            emojiOpen={emojiOpen}
            canPublish={canPublish}
            publishing={publishing}
            canSaveDraft={canSaveDraft}
            savingDraft={savingDraft}
            onToggleEmoji={() => {
              setEmojiOpen((open) => !open);
              if (!emojiOpen) inputRef.current?.blur();
            }}
            onPickPhoto={() => void pickPhoto()}
            onPickVideo={() => void pickVideo()}
            onClear={clearAll}
            onSaveDraft={() => void onSaveDraft()}
            onPublish={() => void onPublish()}
          />
        </View>
      </KeyboardAvoidingView>

      <Modal
        visible={emojiOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setEmojiOpen(false)}
      >
        <Pressable style={styles.emojiBackdrop} onPress={() => setEmojiOpen(false)} />
        <View style={[styles.emojiSheet, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <View style={styles.emojiCard}>
            <ChatMessageEmojiPanel onPickEmoji={insertEmoji} />
          </View>
        </View>
      </Modal>

      <ComposeDraftsSheet
        visible={draftsOpen}
        groups={draftGroups}
        activeScopeModeId={modeId}
        activeDraftUuid={activeDraftUuid}
        onClose={() => setDraftsOpen(false)}
        onSelect={onSelectDraft}
        onCreate={(scopeModeId) => void onCreateDraft(scopeModeId)}
        onRename={(draft, label) => void onRenameDraft(draft, label)}
        onDelete={(draft) => void onDeleteDraft(draft)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  flex: {
    flex: 1,
  },
  topBlock: {
    backgroundColor: floraColors.bg,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: 0,
    gap: floraSpacing.gridFine,
  },
  chromeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
    minHeight: 45,
  },
  iconButton: {
    width: 45,
    minHeight: 45,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  title: {
    flexShrink: 1,
    marginLeft: floraSpacing.grid,
    color: floraColors.whiteTemplate,
    fontSize: 22,
    fontWeight: "300",
    letterSpacing: 0.88,
    lineHeight: 28,
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  headerMenu: {
    minWidth: 180,
    borderRadius: 12,
    backgroundColor: floraColors.popoverInset,
    borderWidth: 1,
    borderColor: floraColors.popoverDivider,
    paddingVertical: 6,
    overflow: "hidden",
  },
  headerMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  headerMenuLabel: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
  },
  editorScroll: {
    paddingBottom: floraSpacing.grid,
    flexGrow: 1,
  },
  emojiBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  emojiSheet: {
    backgroundColor: floraColors.bg,
    paddingHorizontal: floraSpacing.grid,
    paddingTop: floraSpacing.grid,
  },
  emojiCard: {
    height: 320,
    borderRadius: floraMessages.emojiPanelRadius,
    overflow: "hidden",
    backgroundColor: floraColors.surface,
  },
  pressed: {
    opacity: 0.72,
  },
});
