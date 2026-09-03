import { apiUpdatePost, isApiRequestError } from "@flora/client-core/api";
import type { FeedPostDto } from "@flora/client-core/contracts";
import { postImageUrl } from "@flora/client-core/display";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
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
import Reanimated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ComposePostCard } from "@/components/compose/ComposePostCard";
import { ComposeToolbar } from "@/components/compose/ComposeToolbar";
import { ChatMessageEmojiPanel } from "@/components/messages/ChatMessageEmojiPanel";
import {
  MAX_POST_CONTENT_LENGTH,
  clampPostContent,
} from "@/lib/compose/composeModes";
import { uploadPostImagesNative, uploadPostVideoNative } from "@/lib/compose/postMediaUpload";
import {
  useComposePostMedia,
  type DraftPostImage,
  type DraftPostVideo,
} from "@/lib/compose/useComposePostMedia";
import { patchPostInSocialCaches } from "@/lib/patchPostInSocialCaches";
import { useEnergeticSheetMotion } from "@/lib/useEnergeticSheetMotion";
import {
  floraColors,
  floraMessages,
  floraSpacing,
} from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";

type Props = {
  post: FeedPostDto | null;
  onClose: () => void;
};

function seedImages(post: FeedPostDto): DraftPostImage[] {
  return post.imageUuids.map((uuid) => ({
    id: uuid,
    uri: postImageUrl(uuid),
    contentType: "image/jpeg",
    fileName: "photo.jpg",
    preparing: false,
    existingUuid: uuid,
  }));
}

function seedVideo(post: FeedPostDto): DraftPostVideo | null {
  if (!post.videoUuid) return null;
  return {
    id: post.videoUuid,
    uri: "",
    contentType: "video/mp4",
    fileName: "video.mp4",
    existingUuid: post.videoUuid,
  };
}

export function EditPostSheet({ post, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const me = useSessionStore((s) => s.me);
  const [activePost, setActivePost] = useState<FeedPostDto | null>(null);
  const { presented, sheetStyle, backdropStyle } = useEnergeticSheetMotion(post != null, {
    onClosed: () => setActivePost(null),
  });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const media = useComposePostMedia();

  const displayedPost = post ?? activePost;

  useEffect(() => {
    if (!post) return;
    setActivePost(post);
  }, [post]);

  useEffect(() => {
    if (!displayedPost) {
      setText("");
      setError(null);
      setSaving(false);
      setEmojiOpen(false);
      media.clearMedia();
      return;
    }
    setText(displayedPost.text);
    setError(null);
    setSaving(false);
    setEmojiOpen(false);
    media.resetMedia(seedImages(displayedPost), seedVideo(displayedPost));
    // Seed only when the sheet opens on a post; media methods are stable enough per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset from post identity
  }, [displayedPost?.postUuid]);

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

  const keepImageUuids = media.images
    .map((image) => image.existingUuid)
    .filter((uuid): uuid is string => Boolean(uuid));
  const existingVideoKept = Boolean(media.video?.existingUuid);
  const addingImages = media.readyImageFiles.length > 0;
  const addingVideo = media.videoFile != null;
  const original = displayedPost;
  const dirty =
    original != null &&
    (text.trim() !== original.text.trim() ||
      keepImageUuids.join(",") !== original.imageUuids.join(",") ||
      existingVideoKept !== Boolean(original.videoUuid) ||
      addingImages ||
      addingVideo);

  const canSave =
    dirty &&
    !media.hasPendingPrepare &&
    !saving &&
    (text.trim().length > 0 ||
      keepImageUuids.length > 0 ||
      existingVideoKept ||
      addingImages ||
      addingVideo);

  const onSave = useCallback(async () => {
    if (!displayedPost || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      const removeVideo = Boolean(displayedPost.videoUuid) && !existingVideoKept;
      const updated = await apiUpdatePost({
        postUuid: displayedPost.postUuid,
        content: text,
        keepImageUuids,
        removeVideo,
        expectAddedMedia: addingImages || addingVideo,
      });
      let imageUuids = updated.imageUuids;
      let videoUuid = updated.videoUuid;
      let videoStatus = updated.videoStatus;
      if (addingImages) {
        const uploaded = await uploadPostImagesNative(displayedPost.postUuid, media.readyImageFiles);
        imageUuids = [...imageUuids, ...uploaded];
      }
      if (addingVideo && media.videoFile) {
        const uploaded = await uploadPostVideoNative(displayedPost.postUuid, media.videoFile);
        videoUuid = uploaded.videoUuid;
        videoStatus = "processing";
      }
      patchPostInSocialCaches(queryClient, displayedPost.postUuid, {
        text: updated.content,
        imageUuids,
        videoUuid,
        videoStatus,
      });
      onClose();
    } catch (err) {
      setError(isApiRequestError(err) ? err.message : "Не удалось сохранить пост.");
      setSaving(false);
    }
  }, [
    addingImages,
    addingVideo,
    canSave,
    existingVideoKept,
    keepImageUuids,
    media.readyImageFiles,
    media.videoFile,
    onClose,
    displayedPost,
    queryClient,
    text,
  ]);

  if (!presented && !displayedPost) return null;
  if (!displayedPost) return null;

  const communityName = displayedPost.communityName?.trim() || null;
  const displayName = communityName || me?.displayName || displayedPost.authorDisplayName || "Вы";
  const username = communityName ? displayedPost.communitySlug : (me?.username ?? displayedPost.authorUsername);
  const avatarUuid = communityName
    ? displayedPost.communityAvatarUuid
    : (me?.avatarUuid ?? displayedPost.authorAvatarUuid);

  return (
    <Modal
      visible={presented}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.host}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Закрыть"
          onPress={onClose}
        >
          <Reanimated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]} />
        </Pressable>

        <Reanimated.View style={[styles.sheet, sheetStyle]}>
          <KeyboardAvoidingView
            style={styles.root}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
        <View style={[styles.header, { paddingTop: insets.top + floraSpacing.grid }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть"
            style={({ pressed }) => [styles.headerSide, pressed && styles.pressed]}
            onPress={onClose}
          >
            <Ionicons name="close" size={24} color={floraColors.gray} />
          </Pressable>
          <Text style={styles.title}>Редактировать</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Сохранить"
            disabled={!canSave}
            style={({ pressed }) => [
              styles.headerSide,
              styles.headerAction,
              pressed && styles.pressed,
              !canSave && styles.disabled,
            ]}
            onPress={() => void onSave()}
          >
            <Text style={styles.headerActionText}>{saving ? "…" : "Сохранить"}</Text>
          </Pressable>
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.editorScroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <ComposePostCard
            displayName={displayName}
            username={username}
            avatarUuid={avatarUuid}
            communityName={communityName}
            seed={displayedPost.communityUuid ?? displayedPost.authorUserUuid}
            showHandle={!communityName}
            accountBlocked={me?.accountBlocked}
            text={text}
            placeholder="Текст поста"
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

        <View style={{ paddingBottom: Math.max(insets.bottom, 8) }}>
          <ComposeToolbar
            emojiOpen={emojiOpen}
            canPublish={false}
            publishing={false}
            canSaveDraft={false}
            savingDraft={false}
            showDraftActions={false}
            showPublish={false}
            onToggleEmoji={() => {
              setEmojiOpen((open) => !open);
              if (!emojiOpen) inputRef.current?.blur();
            }}
            onPickPhoto={() => {
              void media.pickImages().then((err) => {
                if (err) setError(err);
              });
            }}
            onPickVideo={() => {
              void media.pickVideo().then((err) => {
                if (err) setError(err);
              });
            }}
            onClear={() => undefined}
            onSaveDraft={() => undefined}
            onPublish={() => undefined}
          />
        </View>
          </KeyboardAvoidingView>
        </Reanimated.View>
      </View>

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
    </Modal>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
  },
  backdrop: {
    backgroundColor: "#000",
  },
  sheet: {
    ...StyleSheet.absoluteFill,
  },
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: floraSpacing.gridFine,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
  },
  headerSide: {
    width: 45,
    minHeight: 45,
    alignItems: "center",
    justifyContent: "center",
  },
  headerAction: {
    width: 88,
    alignItems: "flex-end",
  },
  headerActionText: {
    color: floraColors.greenLight,
    fontSize: 16,
    fontWeight: "400",
    letterSpacing: 0.4,
  },
  title: {
    flex: 1,
    textAlign: "center",
    color: floraColors.whiteTemplate,
    fontSize: 18,
    fontWeight: "300",
    letterSpacing: 0.6,
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
  disabled: {
    opacity: 0.4,
  },
});
