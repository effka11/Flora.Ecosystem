import type { PostCommentDto } from "@flora/client-core/contracts";
import { apiAddPostComment, apiGetPostComments } from "@flora/client-core/api";
import { formatAtHandle, profileDisplayName } from "@flora/client-core/display";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { FloraAvatar } from "@/components/FloraAvatar";
import { profileScreenHref } from "@/lib/socialRoutes";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  postUuid: string;
  open: boolean;
  meUsername?: string | null;
  onCommentAdded?: (postUuid: string) => void;
};

function formatRelativeTime(date: string) {
  const ms = new Date(date).getTime();
  if (!Number.isFinite(ms)) return "";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSeconds < 60) return "сейчас";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} мин`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} ч`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} д`;
  return new Date(date).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

type CommentRowProps = {
  comment: PostCommentDto;
  nested?: boolean;
  meUsername?: string | null;
};

function CommentRow({ comment, nested, meUsername }: CommentRowProps) {
  const author = profileDisplayName(comment.authorDisplayName, comment.authorUsername);
  const timeLabel = formatRelativeTime(comment.createdAt);

  return (
    <View style={[styles.commentRow, nested && styles.commentRowNested]}>
      <FloraAvatar
        size={nested ? 28 : 32}
        href={profileScreenHref(comment.authorUsername, meUsername)}
        avatarUuid={comment.authorAvatarUuid}
        displayName={comment.authorDisplayName}
        username={comment.authorUsername}
        seed={comment.authorUserUuid ?? comment.authorUsername}
      />
      <View style={styles.commentBody}>
        <View style={styles.commentMeta}>
          <Text style={styles.commentAuthor} numberOfLines={1}>
            {author}
          </Text>
          <Text style={styles.commentHandle} numberOfLines={1}>
            {formatAtHandle(comment.authorUsername)}
          </Text>
          {timeLabel ? <Text style={styles.commentTime}>{timeLabel}</Text> : null}
        </View>
        <Text style={styles.commentText}>{comment.content}</Text>
        {comment.replies.map((reply) => (
          <CommentRow key={reply.commentUuid} comment={reply} nested meUsername={meUsername} />
        ))}
      </View>
    </View>
  );
}

export function FeedPostComments({ postUuid, open, meUsername, onCommentAdded }: Props) {
  const [items, setItems] = useState<PostCommentDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(!loadedOnce);
    setError(null);
    void apiGetPostComments(postUuid)
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setLoading(false);
        setLoadedOnce(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Не удалось загрузить комментарии");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, postUuid, loadedOnce]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || submitting) return;
    if (text.length > 1000) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const created = await apiAddPostComment(postUuid, text);
      setItems((prev) => [...prev, created]);
      setDraft("");
      onCommentAdded?.(postUuid);
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : "Не удалось отправить комментарий");
    } finally {
      setSubmitting(false);
    }
  }, [draft, onCommentAdded, postUuid, submitting]);

  if (!open) return null;

  return (
    <View style={styles.panel}>
      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={floraColors.greenLight} size="small" />
        </View>
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {!loading && !error && items.length === 0 ? (
        <Text style={styles.emptyText}>Комментариев пока нет.</Text>
      ) : null}
      {items.map((comment) => (
        <CommentRow key={comment.commentUuid} comment={comment} meUsername={meUsername} />
      ))}
      <View style={styles.composer}>
        <TextInput
          style={styles.composerInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Написать комментарий…"
          placeholderTextColor={floraColors.gray}
          multiline
          maxLength={1000}
          editable={!submitting}
        />
        <Pressable
          style={({ pressed }) => [
            styles.sendBtn,
            (!draft.trim() || submitting) && styles.sendBtnDisabled,
            pressed && draft.trim() && !submitting && styles.pressed,
          ]}
          disabled={!draft.trim() || submitting}
          onPress={() => void submit()}
        >
          {submitting ? (
            <ActivityIndicator color={floraColors.greenLight} size="small" />
          ) : (
            <Text style={styles.sendBtnText}>Отправить</Text>
          )}
        </Pressable>
      </View>
      {submitErr ? <Text style={styles.errorText}>{submitErr}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: floraSpacing.gridFine * 2,
    paddingTop: floraSpacing.gridFine * 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(250, 250, 250, 0.08)",
    gap: floraSpacing.grid,
  },
  loadingWrap: {
    paddingVertical: floraSpacing.grid,
    alignItems: "center",
  },
  emptyText: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  errorText: {
    color: floraColors.error,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  commentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: floraSpacing.gridFine * 2,
  },
  commentRowNested: {
    marginTop: floraSpacing.gridFine * 2,
    marginLeft: floraSpacing.grid + floraSpacing.gridFine,
  },
  commentBody: {
    flex: 1,
    minWidth: 0,
    gap: floraSpacing.gridFine,
  },
  commentMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: floraSpacing.gridFine,
  },
  commentAuthor: {
    color: floraColors.whiteTemplate,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
  commentHandle: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  commentTime: {
    color: floraColors.gray,
    fontSize: 12,
    fontWeight: "300",
    letterSpacing: 0.36,
  },
  commentText: {
    color: floraColors.grayLight,
    fontSize: 14,
    fontWeight: "300",
    lineHeight: 22,
    letterSpacing: 0.42,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: floraSpacing.gridFine * 2,
    marginTop: floraSpacing.gridFine,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: "rgba(164, 209, 138, 0.22)",
    borderRadius: floraSpacing.gridFine * 2,
    paddingHorizontal: floraSpacing.gridFine * 2,
    paddingVertical: floraSpacing.gridFine * 2,
    color: floraColors.grayLight,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
  sendBtn: {
    minHeight: 40,
    paddingHorizontal: floraSpacing.grid,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: floraSpacing.gridFine * 2,
    borderWidth: 1,
    borderColor: "rgba(164, 209, 138, 0.35)",
    backgroundColor: "rgba(164, 209, 138, 0.1)",
  },
  sendBtnDisabled: {
    opacity: 0.45,
  },
  sendBtnText: {
    color: floraColors.greenLight,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  pressed: {
    opacity: 0.72,
  },
});
