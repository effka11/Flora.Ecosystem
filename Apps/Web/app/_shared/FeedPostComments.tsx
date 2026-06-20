"use client";

import Link from "next/link";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type TransitionEvent,
} from "react";
import {
  CommentMentionComposer,
  type CommentMentionComposerHandle,
} from "@/app/_shared/CommentMentionComposer";
import { formatAtHandle, profileDisplayName } from "@/app/_dashboard/userDisplay";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import { formatRelativeTimeRu } from "@/lib/formatRelativeTimeRu";
import {
  ensurePostCommentsPrefetched,
  getCachedPostComments,
  patchCommentRepliesInTree,
  setCachedPostComments,
} from "@/lib/postCommentsCache";
import {
  apiCreatePostComment,
  apiGetCommentReplies,
  type PeopleSearchUserDto,
  type PostCommentDto,
} from "@/lib/socialApi";
import { floraDurationMs } from "@/lib/floraMotion";
import { CommentBodyText } from "@/app/_shared/CommentBodyText";
import { PostMoreMenu } from "@/app/_shared/PostMoreMenu";
import styles from "./FeedPostComments.module.css";

function profileHref(username: string) {
  const slug = username.trim().replace(/^@+/, "");
  return `/profile/${encodeURIComponent(slug || "user")}`;
}

function ancestorIdsForComment(
  nodes: PostCommentDto[],
  targetUuid: string,
  chain: string[] = [],
): string[] | null {
  for (const n of nodes) {
    if (n.commentUuid === targetUuid) return [...chain, n.commentUuid];
    if (n.replies?.length) {
      const found = ancestorIdsForComment(n.replies, targetUuid, [...chain, n.commentUuid]);
      if (found) return found;
    }
  }
  return null;
}

function insertCommentReply(
  items: PostCommentDto[],
  parentCommentUuid: string,
  reply: PostCommentDto,
): PostCommentDto[] {
  return items.map((c) => {
    if (c.commentUuid === parentCommentUuid) {
      const replies = [...(c.replies ?? []), reply];
      return { ...c, replies, repliesCount: replies.length };
    }
    if (c.replies?.length) {
      return { ...c, replies: insertCommentReply(c.replies, parentCommentUuid, reply) };
    }
    return c;
  });
}

function buildLikeState(comments: PostCommentDto[]): Record<string, { count: number; liked: boolean }> {
  const likes: Record<string, { count: number; liked: boolean }> = {};
  const seed = (x: PostCommentDto) => {
    likes[x.commentUuid] = { count: likeSeed(x.commentUuid), liked: false };
    for (const r of x.replies ?? []) seed(r);
  };
  for (const c of comments) seed(c);
  return likes;
}

function findCommentInTree(nodes: PostCommentDto[], commentUuid: string): PostCommentDto | null {
  for (const n of nodes) {
    if (n.commentUuid === commentUuid) return n;
    if (n.replies?.length) {
      const nested = findCommentInTree(n.replies, commentUuid);
      if (nested) return nested;
    }
  }
  return null;
}

function likeSeed(commentUuid: string): number {
  let h = 0;
  for (let i = 0; i < commentUuid.length; i++) h = (h * 31 + commentUuid.charCodeAt(i)) | 0;
  return Math.abs(h) % 19;
}

type ReplyComposerTarget = {
  commentUuid: string;
  username: string;
  displayName: string;
};

function collectCommentAuthors(items: PostCommentDto[]): PeopleSearchUserDto[] {
  const map = new Map<string, PeopleSearchUserDto>();
  const walk = (c: PostCommentDto) => {
    const username = c.authorUsername.trim().replace(/^@+/, "");
    if (username.length >= 2) {
      map.set(username.toLowerCase(), {
        username,
        displayName: c.authorDisplayName,
        isFollowing: false,
      });
    }
    for (const r of c.replies ?? []) walk(r);
  };
  for (const c of items) walk(c);
  return [...map.values()];
}

const COMMENT_EMOJI_PALETTE = [
  "😀",
  "😂",
  "🥰",
  "😊",
  "😮",
  "😢",
  "👍",
  "👎",
  "❤️",
  "🔥",
  "✨",
  "🙏",
  "👋",
  "💬",
  "🎉",
  "😅",
  "🤔",
  "😭",
  "💯",
  "⭐",
  "✅",
  "❌",
  "📎",
  "🖼",
] as const;

type BeginReplyOptions = {
  /** Корневой комментарий ветки (parent для API и адресат ответа). */
  threadParentUuid: string;
  /** Ответ из вложенной ветки — адресат = автор корневого комментария, не автор ответа. */
  isReplyToReply: boolean;
};

type CommentCardProps = {
  c: PostCommentDto;
  variant: "root" | "reply";
  threadParentUuid: string;
  likeState: Record<string, { count: number; liked: boolean }>;
  toggleLike: (commentUuid: string) => void;
  repliesExpanded: Record<string, boolean>;
  repliesFetching: Record<string, boolean>;
  toggleReplies: (commentUuid: string) => void;
  beginReply: (c: PostCommentDto, options: BeginReplyOptions) => void;
};

function CommentCard({
  c,
  variant,
  threadParentUuid,
  likeState,
  toggleLike,
  repliesExpanded,
  repliesFetching,
  toggleReplies,
  beginReply,
}: CommentCardProps) {
  const handle = formatAtHandle(c.authorUsername);
  const author = profileDisplayName(c.authorDisplayName, c.authorUsername);
  const timeLabel = formatRelativeTimeRu(c.createdAt);
  const ls = likeState[c.commentUuid] ?? { count: 0, liked: false };
  const repliesOpen = !!repliesExpanded[c.commentUuid];
  const replyList = c.replies ?? [];
  const hasReplyBodies = replyList.length > 0;
  const replyBadge = Math.max(c.repliesCount, replyList.length);
  const repliesLoading = !!repliesFetching[c.commentUuid];
  const isRoot = variant === "root";
  const moreWrapClass = isRoot ? styles.commentMoreWrap : styles.commentMoreWrapNested;
  const liClass = isRoot ? styles.item : styles.replyItem;

  return (
    <li className={liClass}>
      <FloraAvatar
        href={profileHref(c.authorUsername)}
        avatarUuid={c.authorAvatarUuid}
        displayName={c.authorDisplayName}
        username={c.authorUsername}
        seed={c.authorUserUuid ?? c.authorUsername}
        className={styles.avatar}
      />
      <div className={styles.metaRow}>
        <Link href={profileHref(c.authorUsername)} className={styles.authorLink}>
          <span className={styles.author}>{author}</span>
          <span className={styles.handle}>{handle}</span>
        </Link>
        <PostMoreMenu
          wrapClassName={moreWrapClass}
          buttonClassName={styles.commentMoreBtn}
          variant="comment"
          sharePath={profileHref(c.authorUsername)}
          accessibility={{
            dialog: "Меню комментария",
            triggerOpen: "Меню комментария",
            triggerClose: "Закрыть меню комментария",
          }}
        />
      </div>
      <div className={styles.main}>
        <CommentBodyText content={c.content} className={styles.body} />
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.actionBtn} ${ls.liked ? styles.actionBtnLikeOn : ""}`}
            aria-pressed={ls.liked}
            aria-label={ls.liked ? "Убрать лайк" : "Лайкнуть комментарий"}
            onClick={() => toggleLike(c.commentUuid)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill={ls.liked ? "currentColor" : "none"} aria-hidden>
              <path
                d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
            <span>{ls.count}</span>
          </button>
          {isRoot ? (
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.replyThreadBtn}${repliesOpen ? ` ${styles.replyThreadBtnOpen}` : ""}`}
              aria-expanded={repliesOpen}
              aria-label={
                repliesOpen ? `Скрыть ответы, ${replyBadge}` : `Показать ответы, ${replyBadge}`
              }
              onClick={() => toggleReplies(c.commentUuid)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span>{replyBadge}</span>
            </button>
          ) : null}
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.replyAnswerBtn}`}
            onClick={() =>
              beginReply(c, { threadParentUuid, isReplyToReply: !isRoot })
            }
          >
            Ответить
          </button>
          <time className={styles.time} dateTime={c.createdAt}>
            {timeLabel}
          </time>
        </div>
        {isRoot ? (
          <RepliesReveal open={repliesOpen}>
            <div
              className={styles.repliesPanel}
              role="region"
              aria-label={`Ответы к комментарию, ${replyBadge}`}
            >
              {replyBadge === 0 ? (
                <p className={styles.repliesEmpty}>Ответов пока нет.</p>
              ) : hasReplyBodies ? (
                <ul className={styles.replyList}>
                  {replyList.map((r) => (
                    <CommentCard
                      key={r.commentUuid}
                      c={r}
                      variant="reply"
                      threadParentUuid={c.commentUuid}
                      likeState={likeState}
                      toggleLike={toggleLike}
                      repliesExpanded={repliesExpanded}
                      repliesFetching={repliesFetching}
                      toggleReplies={toggleReplies}
                      beginReply={beginReply}
                    />
                  ))}
                </ul>
              ) : repliesLoading ? null : (
                <p className={styles.repliesEmpty}>Ответы ещё не подгружены.</p>
              )}
            </div>
          </RepliesReveal>
        ) : null}
      </div>
    </li>
  );
}

export type FeedPostCommentsProps = {
  postUuid: string;
  open: boolean;
  onCommentAdded?: (postUuid: string) => void;
};

type CommentsPanelPhase = "gone" | "entering" | "open" | "closing";

/** Запас после скрытия панели (= `--flora-duration-3`); см. `floraDurationMs`. */
const PANEL_CLOSE_FALLBACK_MS = floraDurationMs(3) + 100;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function initialPhase(isOpen: boolean): CommentsPanelPhase {
  if (!isOpen) return "gone";
  return prefersReducedMotion() ? "open" : "entering";
}

function initialLayoutExpanded(isOpen: boolean): boolean {
  if (!isOpen) return false;
  return prefersReducedMotion();
}

/** Визуальная фаза обёртки: `idle` пока строка grid 0fr, чтобы keyframes не «сгорели» в нулевой высоте. */
function threadWrapVisualPhase(phase: CommentsPanelPhase, layoutExpanded: boolean): "idle" | "open" | "closing" {
  if (phase === "closing") return "closing";
  if (phase === "entering" && !layoutExpanded) return "idle";
  return "open";
}

type RepliesRevealProps = {
  open: boolean;
  children: React.ReactNode;
};

/** Раскрытие/схлопывание ответов: тот же grid 0fr↔1fr + opacity, что у панели комментариев. */
function RepliesReveal({ open, children }: RepliesRevealProps) {
  const phaseRef = useRef<CommentsPanelPhase>(initialPhase(open));
  const [phase, setPhase] = useState<CommentsPanelPhase>(() => initialPhase(open));
  const [layoutExpanded, setLayoutExpanded] = useState(() => initialLayoutExpanded(open));

  phaseRef.current = phase;

  useLayoutEffect(() => {
    const p = phaseRef.current;
    if (!open) {
      if (p === "open" || p === "entering") {
        setPhase("closing");
        setLayoutExpanded(false);
      }
      return;
    }
    if (p === "gone") {
      setPhase(prefersReducedMotion() ? "open" : "entering");
      return;
    }
    if (p === "closing") {
      setPhase("open");
      setLayoutExpanded(true);
    }
  }, [open]);

  useLayoutEffect(() => {
    if (phase === "gone") {
      setLayoutExpanded(false);
    }
  }, [phase]);

  useLayoutEffect(() => {
    if (!open) return;
    if (phase !== "open") return;
    setLayoutExpanded(true);
  }, [open, phase]);

  useEffect(() => {
    if (phase !== "entering") return;
    if (prefersReducedMotion()) return;
    /* Первый paint уже с layoutExpanded=false (0fr); без лишнего rAF — transition стартует сразу после commit. */
    setLayoutExpanded(true);
  }, [phase]);

  const finishRepliesClose = useCallback(() => {
    setPhase((p) => (p === "closing" ? "gone" : p));
  }, []);

  const onShellLayoutTransitionEnd = useCallback((e: TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.propertyName !== "grid-template-rows") return;
    setPhase((p) => (p === "entering" ? "open" : p));
  }, []);

  useEffect(() => {
    if (phase !== "closing") return;
    const id = window.setTimeout(() => {
      finishRepliesClose();
    }, PANEL_CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [phase, finishRepliesClose]);

  useEffect(() => {
    if (phase !== "entering") return;
    const id = window.setTimeout(() => {
      setPhase((p) => (p === "entering" ? "open" : p));
    }, PANEL_CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  if (phase === "gone") return null;

  const wrapPhase = threadWrapVisualPhase(phase, layoutExpanded);

  return (
    <div
      className={styles.panelLayoutShell}
      data-layout-expanded={layoutExpanded ? "true" : "false"}
      onTransitionEnd={onShellLayoutTransitionEnd}
    >
      <div className={styles.panelLayoutInner}>
        <div
          className={styles.threadWrap}
          data-phase={wrapPhase}
          onTransitionEnd={(e) => {
            if (e.target !== e.currentTarget || e.propertyName !== "opacity") return;
            finishRepliesClose();
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function FeedPostComments({ postUuid, open, onCommentAdded }: FeedPostCommentsProps) {
  const [items, setItems] = useState<PostCommentDto[]>(() => getCachedPostComments(postUuid) ?? []);
  const [loading, setLoading] = useState(() => getCachedPostComments(postUuid) == null);
  const [error, setError] = useState<string | null>(null);
  const [likeState, setLikeState] = useState<Record<string, { count: number; liked: boolean }>>(() => {
    const cached = getCachedPostComments(postUuid);
    return cached ? buildLikeState(cached) : {};
  });
  const [composerPlain, setComposerPlain] = useState("");
  const [replyTo, setReplyTo] = useState<ReplyComposerTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [repliesExpanded, setRepliesExpanded] = useState<Record<string, boolean>>({});
  const [repliesFetching, setRepliesFetching] = useState<Record<string, boolean>>({});
  const itemsRef = useRef(items);
  const repliesFetchInFlightRef = useRef(new Set<string>());
  itemsRef.current = items;
  const composerRef = useRef<CommentMentionComposerHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const emojiPopoverRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<CommentsPanelPhase>(initialPhase(open));
  const [phase, setPhase] = useState<CommentsPanelPhase>(() => initialPhase(open));
  const [layoutExpanded, setLayoutExpanded] = useState(() => initialLayoutExpanded(open));

  phaseRef.current = phase;

  /** До paint: закрытие + схлопывание grid в одном такте с `closing`, без кадра задержки от `useEffect`. */
  useLayoutEffect(() => {
    const p = phaseRef.current;
    if (!open) {
      if (p === "open" || p === "entering") {
        setPhase("closing");
        setLayoutExpanded(false);
      }
      return;
    }
    if (p === "gone") {
      setPhase(prefersReducedMotion() ? "open" : "entering");
      return;
    }
    if (p === "closing") {
      setPhase("open");
      setLayoutExpanded(true);
    }
  }, [open]);

  useLayoutEffect(() => {
    if (phase === "gone") {
      setLayoutExpanded(false);
    }
  }, [phase]);

  useLayoutEffect(() => {
    if (!open) return;
    if (phase !== "open") return;
    setLayoutExpanded(true);
  }, [open, phase]);

  const mentionLocalUsers = useMemo(() => collectCommentAuthors(items), [items]);

  useEffect(() => {
    if (phase !== "entering") return;
    if (prefersReducedMotion()) return;
    setLayoutExpanded(true);
  }, [phase]);

  const finishClosingIfNeeded = useCallback(() => {
    setPhase((p) => {
      if (p !== "closing") return p;
      if (open) return "open";
      return "gone";
    });
  }, [open]);

  const onShellLayoutTransitionEnd = useCallback((e: TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.propertyName !== "grid-template-rows") return;
    setPhase((p) => (p === "entering" ? "open" : p));
  }, []);

  useEffect(() => {
    if (phase !== "closing") return;
    const id = window.setTimeout(() => {
      finishClosingIfNeeded();
    }, PANEL_CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [phase, finishClosingIfNeeded]);

  useEffect(() => {
    if (phase !== "entering") return;
    const id = window.setTimeout(() => {
      setPhase((p) => (p === "entering" ? "open" : p));
    }, PANEL_CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedPostComments(postUuid);
    if (cached) {
      setItems(cached);
      setLikeState(buildLikeState(cached));
      setLoading(false);
      setError(null);
    } else {
      setItems([]);
      setLoading(true);
      setError(null);
    }

    void ensurePostCommentsPrefetched(postUuid)
      .then((list) => {
        if (cancelled) return;
        startTransition(() => {
          setItems(list);
          setLikeState(buildLikeState(list));
          setLoading(false);
          setError(null);
        });
      })
      .catch((e) => {
        if (cancelled) return;
        if (getCachedPostComments(postUuid)) return;
        startTransition(() => {
          setItems([]);
          setError(e instanceof Error ? e.message : "Не удалось загрузить комментарии");
          setLoading(false);
        });
      });

    return () => {
      cancelled = true;
    };
  }, [postUuid]);

  const loadRepliesQuietly = useCallback(
    async (commentUuid: string) => {
      const node = findCommentInTree(itemsRef.current, commentUuid);
      if (!node) return;
      if ((node.replies?.length ?? 0) > 0) return;
      if (node.repliesCount <= 0) return;
      if (repliesFetchInFlightRef.current.has(commentUuid)) return;

      repliesFetchInFlightRef.current.add(commentUuid);
      setRepliesFetching((prev) => ({ ...prev, [commentUuid]: true }));
      try {
        const replies = await apiGetCommentReplies(postUuid, commentUuid);
        setItems((prev) => {
          const next = patchCommentRepliesInTree(prev, commentUuid, replies);
          setCachedPostComments(postUuid, next);
          return next;
        });
        setLikeState((prev) => ({ ...prev, ...buildLikeState(replies) }));
      } catch {
        /* тихая подгрузка */
      } finally {
        repliesFetchInFlightRef.current.delete(commentUuid);
        setRepliesFetching((prev) => {
          const next = { ...prev };
          delete next[commentUuid];
          return next;
        });
      }
    },
    [postUuid],
  );

  const toggleReplies = useCallback(
    (commentUuid: string) => {
      setRepliesExpanded((prev) => {
        const opening = !prev[commentUuid];
        if (opening) void loadRepliesQuietly(commentUuid);
        return { ...prev, [commentUuid]: opening };
      });
    },
    [loadRepliesQuietly],
  );

  const toggleLike = useCallback((commentUuid: string) => {
    setLikeState((prev) => {
      const cur = prev[commentUuid] ?? { count: 0, liked: false };
      const liked = !cur.liked;
      return {
        ...prev,
        [commentUuid]: { count: Math.max(0, cur.count + (liked ? 1 : -1)), liked },
      };
    });
  }, []);

  const beginReply = useCallback((c: PostCommentDto, options: BeginReplyOptions) => {
    const parent =
      options.isReplyToReply
        ? findCommentInTree(itemsRef.current, options.threadParentUuid)
        : c;
    if (!parent) return;

    setReplyTo({
      commentUuid: parent.commentUuid,
      username: parent.authorUsername,
      displayName: parent.authorDisplayName,
    });
    composerRef.current?.clear();
    setComposerPlain("");
    queueMicrotask(() => {
      composerRef.current?.focus();
      if (options.isReplyToReply) {
        composerRef.current?.insertMention(c.authorUsername, ",");
      }
    });
  }, []);

  const submit = useCallback(async () => {
    const text = composerRef.current?.getPlainText().trim() ?? composerPlain.trim();
    if (text.length === 0 || submitting) return;
    if (text.length > 1000) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const parentCommentUuid = replyTo?.commentUuid ?? null;
      const created = await apiCreatePostComment(postUuid, text, parentCommentUuid);
      if (parentCommentUuid) {
        setItems((prev) => {
          const next = insertCommentReply(prev, parentCommentUuid, created);
          setCachedPostComments(postUuid, next);
          return next;
        });
        setRepliesExpanded((prev) => {
          const ids = ancestorIdsForComment(items, parentCommentUuid) ?? [parentCommentUuid];
          const next = { ...prev };
          for (const id of ids) next[id] = true;
          return next;
        });
      } else {
        setItems((prev) => {
          const next = [created, ...prev];
          setCachedPostComments(postUuid, next);
          return next;
        });
      }
      setLikeState((prev) => ({
        ...prev,
        [created.commentUuid]: { count: likeSeed(created.commentUuid), liked: false },
      }));
      composerRef.current?.clear();
      setComposerPlain("");
      setReplyTo(null);
      onCommentAdded?.(postUuid);
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : "Не удалось отправить");
    } finally {
      setSubmitting(false);
    }
  }, [composerPlain, items, onCommentAdded, postUuid, replyTo?.commentUuid, submitting]);

  const insertAtCaret = useCallback((text: string) => {
    composerRef.current?.insertText(text);
  }, []);

  const onAttachChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    e.target.value = "";
    if (!files?.length) return;
    setAttachNotice("Вложения к комментариям пока не поддерживаются");
    window.setTimeout(() => setAttachNotice(null), 4000);
  }, []);

  useEffect(() => {
    if (!emojiOpen) return;
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (emojiPopoverRef.current?.contains(t)) return;
      if (emojiBtnRef.current?.contains(t)) return;
      setEmojiOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [emojiOpen]);

  if (phase === "gone") return null;

  const wrapPhase = threadWrapVisualPhase(phase, layoutExpanded);

  return (
    <div
      className={styles.panelLayoutShell}
      data-layout-expanded={layoutExpanded ? "true" : "false"}
      onTransitionEnd={onShellLayoutTransitionEnd}
    >
      <div className={styles.panelLayoutInner}>
        <div
          className={styles.threadWrap}
          data-phase={wrapPhase}
          onTransitionEnd={(e) => {
            if (e.target !== e.currentTarget || e.propertyName !== "opacity") return;
            finishClosingIfNeeded();
          }}
        >
      <section
        className={styles.thread}
        aria-label="Комментарии к посту"
        aria-busy={open && loading && items.length === 0}
      >
      {error ? (
        <p className={`${styles.statusLine} ${styles.statusLineErr}`} role="alert">
          {error}
        </p>
      ) : null}
      {open && loading && items.length === 0 ? (
        <p className={styles.statusLine} aria-live="polite">
          Загрузка комментариев…
        </p>
      ) : null}
      {!loading && !error && items.length === 0 ? (
        <p className={styles.statusLine}>Пока нет комментариев. Напишите первым.</p>
      ) : null}
      <ul className={styles.list}>
        {items.map((c) => (
          <CommentCard
            key={c.commentUuid}
            c={c}
            variant="root"
            threadParentUuid={c.commentUuid}
            likeState={likeState}
            toggleLike={toggleLike}
            repliesExpanded={repliesExpanded}
            repliesFetching={repliesFetching}
            toggleReplies={toggleReplies}
            beginReply={beginReply}
          />
        ))}
      </ul>

      <div className={styles.composerWrap}>
        <div className={styles.composerRow}>
          <div className={styles.composerFieldWrap}>
            <div className={styles.composerInputBox}>
              <CommentMentionComposer
                ref={composerRef}
                localUsers={mentionLocalUsers}
                placeholder={replyTo ? "Написать ответ…" : "Написать комментарий…"}
                ariaLabel={
                  replyTo
                    ? `Ответ на комментарий пользователя ${formatAtHandle(replyTo.username)}. Введите @ для упоминания. Отправка: кнопка справа или Ctrl+Enter / ⌘+Enter.`
                    : "Текст комментария. Введите @ для упоминания. Отправка: кнопка справа или Ctrl+Enter / ⌘+Enter."
                }
                maxLength={1000}
                disabled={submitting}
                onPlainTextChange={setComposerPlain}
                onSubmit={() => void submit()}
              />
            <div className={styles.composerFieldIcons} role="toolbar" aria-label="Действия с комментарием">
              <div className={styles.composerEmojiAnchor}>
                <button
                  ref={emojiBtnRef}
                  type="button"
                  className={styles.composerIconBtn}
                  aria-expanded={emojiOpen}
                  aria-haspopup="listbox"
                  aria-label="Вставить эмодзи"
                  onClick={() => setEmojiOpen((o) => !o)}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                    <circle cx="12" cy="12" r="9" />
                    <circle cx="9" cy="10" r="1" fill="currentColor" stroke="none" />
                    <circle cx="15" cy="10" r="1" fill="currentColor" stroke="none" />
                    <path d="M8 15a6 6 0 0 0 8 0" strokeLinecap="round" />
                  </svg>
                </button>
                {emojiOpen ? (
                  <div ref={emojiPopoverRef} className={styles.emojiPopover} role="listbox" aria-label="Выбор эмодзи">
                    {COMMENT_EMOJI_PALETTE.map((ch) => (
                      <button
                        key={ch}
                        type="button"
                        className={styles.emojiPick}
                        role="option"
                        aria-label={`Вставить ${ch}`}
                        onClick={() => {
                          insertAtCaret(ch);
                          setEmojiOpen(false);
                        }}
                      >
                        {ch}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                className={styles.fileInputHidden}
                tabIndex={-1}
                aria-label="Выбор файлов для вложения"
                multiple
                onChange={onAttachChange}
              />
              <button
                type="button"
                className={styles.composerIconBtn}
                aria-label="Прикрепить файл"
                onClick={() => fileInputRef.current?.click()}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                  <path d="M21.44 11.05l-9.2 9.19a5 5 0 1 1-7.07-7.07l9.19-9.2a3 3 0 0 1 4.24 4.24l-9.2 9.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className={`${styles.composerIconBtn} ${styles.composerIconBtnSend}${composerPlain.trim().length > 0 && !submitting ? ` ${styles.composerIconBtnSendReady}` : ""}`}
                aria-label={submitting ? "Отправка…" : "Отправить комментарий"}
                disabled={submitting || composerPlain.trim().length === 0}
                onClick={() => void submit()}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                  <path d="M22 2L11 13" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M22 2L15 22l-4-9-9-4L22 2z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            </div>
          </div>
          {attachNotice ? (
            <p className={styles.attachNotice} role="status" aria-live="polite">
              {attachNotice}
            </p>
          ) : null}
          {submitErr ? <p className={styles.submitErr}>{submitErr}</p> : null}
          {replyTo ? (
            <div className={styles.composerActions}>
              <p className={styles.replyComposerHint} role="status">
                Ответ на комментарий пользователя{" "}
                <span className={styles.replyComposerHintHandle}>{formatAtHandle(replyTo.username)}</span>
              </p>
              <button
                type="button"
                className={styles.actionBtn}
                onClick={() => {
                  setReplyTo(null);
                  composerRef.current?.clear();
                  setComposerPlain("");
                }}
              >
                Сбросить ответ
              </button>
            </div>
          ) : null}
        </div>
      </div>
      </section>
        </div>
      </div>
    </div>
  );
}
