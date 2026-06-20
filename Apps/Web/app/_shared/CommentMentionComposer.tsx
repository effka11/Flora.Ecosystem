"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { formatAtHandle } from "@/app/_dashboard/userDisplay";
import {
  abandonMentionQuery,
  commitMentionQuery,
  editorToPlainText,
  findKnownUsername,
  getCaretRect,
  getMentionQueryAtCaret,
  insertMentionChipAtCaret,
  insertTextAtCaret,
  isEditorEmpty,
  isExactMentionMatch,
  isMentionTerminator,
  normalizeMentionUsername,
  removeMentionChipBeforeCaret,
} from "@/lib/commentMentionComposer";
import { apiSearchUsers, type PeopleSearchUserDto } from "@/lib/socialApi";
import styles from "./FeedPostComments.module.css";

export type CommentMentionComposerHandle = {
  focus: () => void;
  clear: () => void;
  insertMention: (username: string, suffix?: string) => void;
  insertText: (text: string) => void;
  getPlainText: () => string;
  isEmpty: () => boolean;
};

type CommentMentionComposerProps = {
  placeholder?: string;
  maxLength?: number;
  ariaLabel?: string;
  localUsers?: PeopleSearchUserDto[];
  onPlainTextChange?: (text: string) => void;
  onSubmit?: () => void;
  disabled?: boolean;
};

function rankLocalUsers(users: PeopleSearchUserDto[], query: string): PeopleSearchUserDto[] {
  const q = query.trim().toLowerCase();
  if (!q) return users.slice(0, 8);
  return users
    .filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q),
    )
    .sort((a, b) => {
      const au = a.username.toLowerCase();
      const bu = b.username.toLowerCase();
      const aStarts = au.startsWith(q) ? 0 : 1;
      const bStarts = bu.startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return au.localeCompare(bu);
    })
    .slice(0, 8);
}

function mergeUserPools(...pools: PeopleSearchUserDto[][]): PeopleSearchUserDto[] {
  const map = new Map<string, PeopleSearchUserDto>();
  for (const pool of pools) {
    for (const u of pool) map.set(u.username.toLowerCase(), u);
  }
  return [...map.values()];
}

export const CommentMentionComposer = forwardRef<CommentMentionComposerHandle, CommentMentionComposerProps>(
  function CommentMentionComposer(
    {
      placeholder,
      maxLength = 1000,
      ariaLabel,
      localUsers = [],
      onPlainTextChange,
      onSubmit,
      disabled = false,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null);
    const suggestRef = useRef<HTMLUListElement>(null);
    const searchSeqRef = useRef(0);
    const suggestItemsRef = useRef<PeopleSearchUserDto[]>([]);
    const searchCacheRef = useRef<{ query: string; users: PeopleSearchUserDto[]; complete: boolean } | null>(null);
    const terminatorHandledRef = useRef(false);
    const localUsersRef = useRef(localUsers);
    localUsersRef.current = localUsers;

    const [suggestOpen, setSuggestOpen] = useState(false);
    const [suggestItems, setSuggestItems] = useState<PeopleSearchUserDto[]>([]);
    const [suggestIndex, setSuggestIndex] = useState(0);
    const [suggestStyle, setSuggestStyle] = useState<{ top: number; left: number } | null>(null);

    suggestItemsRef.current = suggestItems;

    const syncPlainText = useCallback(() => {
      const editor = editorRef.current;
      if (!editor) return "";
      let plain = editorToPlainText(editor);
      if (plain.length > maxLength) {
        plain = plain.slice(0, maxLength);
      }
      onPlainTextChange?.(plain);
      return plain;
    }, [maxLength, onPlainTextChange]);

    const updateSuggestPosition = useCallback(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const caret = getCaretRect(editor);
      const box = editor.getBoundingClientRect();
      if (!caret) return;
      setSuggestStyle({
        top: caret.bottom - box.top + 4,
        left: Math.max(0, caret.left - box.left),
      });
    }, []);

    const closeSuggest = useCallback(() => {
      setSuggestOpen(false);
      setSuggestItems([]);
      setSuggestIndex(0);
      setSuggestStyle(null);
    }, []);

    const resolveExistingUsername = useCallback(async (raw: string): Promise<string | null> => {
      const q = normalizeMentionUsername(raw);
      if (q.length < 2) return null;

      const pools = mergeUserPools(localUsersRef.current, suggestItemsRef.current);
      const known = findKnownUsername(q, pools);
      if (known) return known;

      const cache = searchCacheRef.current;
      if (cache?.query === q.toLowerCase()) {
        const cached = findKnownUsername(q, cache.users);
        if (cached) return cached;
        if (cache.complete) return null;
      }

      try {
        const remote = await apiSearchUsers(q, 0, 12);
        searchCacheRef.current = { query: q.toLowerCase(), users: remote, complete: true };
        return findKnownUsername(q, remote);
      } catch {
        return null;
      }
    }, []);

    const openSuggest = useCallback(
      async (query: string) => {
        const q = normalizeMentionUsername(query).toLowerCase();
        const local = rankLocalUsers(localUsers, query);
        setSuggestItems(local);
        setSuggestIndex(0);
        setSuggestOpen(local.length > 0 || query.length > 0);
        updateSuggestPosition();

        const seq = ++searchSeqRef.current;
        if (q.length === 0) {
          searchCacheRef.current = null;
          return;
        }
        searchCacheRef.current = { query: q, users: local, complete: false };
        try {
          const remote = await apiSearchUsers(q, 0, 12);
          if (seq !== searchSeqRef.current) return;
          const merged = new Map<string, PeopleSearchUserDto>();
          for (const u of local) merged.set(u.username.toLowerCase(), u);
          for (const u of remote) {
            const key = u.username.toLowerCase();
            if (!merged.has(key)) merged.set(key, u);
          }
          const items = [...merged.values()].slice(0, 8);
          const pool = [...merged.values()];
          searchCacheRef.current = { query: q, users: pool, complete: true };
          setSuggestItems(items);
          setSuggestOpen(items.length > 0);
        } catch {
          if (seq === searchSeqRef.current) {
            searchCacheRef.current = { query: q, users: local, complete: true };
            setSuggestOpen(local.length > 0);
          }
        }
      },
      [localUsers, updateSuggestPosition],
    );

    const applyMention = useCallback(
      (username: string, suffix = "") => {
        const editor = editorRef.current;
        if (!editor) return;
        const resolved = findKnownUsername(
          username,
          mergeUserPools(localUsersRef.current, suggestItemsRef.current),
        );
        if (!resolved) return;

        const ctx = getMentionQueryAtCaret(editor);
        if (ctx) {
          commitMentionQuery(ctx, resolved, styles.mentionChip, suffix, { allowPartialQuery: true });
        } else {
          insertMentionChipAtCaret(editor, resolved, styles.mentionChip, suffix);
        }
        closeSuggest();
        syncPlainText();
      },
      [closeSuggest, syncPlainText],
    );

    const finishMentionTerminator = useCallback(
      (capturedCtx: NonNullable<ReturnType<typeof getMentionQueryAtCaret>>, char: string, resolved: string | null) => {
        if (resolved && isExactMentionMatch(capturedCtx.query, resolved)) {
          commitMentionQuery(capturedCtx, resolved, styles.mentionChip, char);
        } else {
          abandonMentionQuery(capturedCtx, char);
        }
        closeSuggest();
        syncPlainText();
      },
      [closeSuggest, syncPlainText],
    );

    const processMentionTerminator = useCallback(
      (char: string, editor: HTMLElement): boolean => {
        const ctx = getMentionQueryAtCaret(editor);
        if (!ctx) return false;
        const normalized = normalizeMentionUsername(ctx.query);
        if (normalized.length < 2) return false;

        const capturedCtx = ctx;
        const pools = mergeUserPools(localUsersRef.current, suggestItemsRef.current);
        const syncResolved = findKnownUsername(normalized, pools);
        if (syncResolved && isExactMentionMatch(normalized, syncResolved)) {
          finishMentionTerminator(capturedCtx, char, syncResolved);
          return true;
        }

        const cache = searchCacheRef.current;
        if (cache?.query === normalized.toLowerCase() && cache.complete) {
          const cachedResolved = findKnownUsername(normalized, cache.users);
          finishMentionTerminator(
            capturedCtx,
            char,
            cachedResolved && isExactMentionMatch(normalized, cachedResolved) ? cachedResolved : null,
          );
          return true;
        }

        void resolveExistingUsername(normalized).then((resolved) => {
          if (!capturedCtx.textNode.isConnected) return;
          finishMentionTerminator(
            capturedCtx,
            char,
            resolved && isExactMentionMatch(normalized, resolved) ? resolved : null,
          );
        });
        return true;
      },
      [finishMentionTerminator, resolveExistingUsername],
    );

    const refreshMentionSuggest = useCallback(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const ctx = getMentionQueryAtCaret(editor);
      if (!ctx) {
        closeSuggest();
        return;
      }
      void openSuggest(ctx.query);
    }, [closeSuggest, openSuggest]);

    const handleInput = useCallback(() => {
      syncPlainText();
      refreshMentionSuggest();
    }, [refreshMentionSuggest, syncPlainText]);

    const handlePaste = useCallback(
      (e: React.ClipboardEvent<HTMLDivElement>) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain").replace(/\r\n/g, "\n");
        insertTextAtCaret(e.currentTarget, text);
        handleInput();
      },
      [handleInput],
    );

    const handleBeforeInput = useCallback(
      (e: FormEvent<HTMLDivElement>) => {
        if (disabled) return;
        const native = e.nativeEvent;
        if (!(native instanceof InputEvent)) return;
        if (native.inputType !== "insertText" || !native.data || native.data.length !== 1) return;
        if (!isMentionTerminator(native.data)) return;

        const editor = editorRef.current;
        if (!editor) return;

        if (processMentionTerminator(native.data, editor)) {
          e.preventDefault();
          terminatorHandledRef.current = true;
        }
      },
      [disabled, processMentionTerminator],
    );

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        const editor = e.currentTarget;

        if (suggestOpen && suggestItems.length > 0) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSuggestIndex((i) => (i + 1) % suggestItems.length);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setSuggestIndex((i) => (i - 1 + suggestItems.length) % suggestItems.length);
            return;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            const pick = suggestItems[suggestIndex];
            if (pick) applyMention(pick.username);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            closeSuggest();
            return;
          }
        }

        if (e.key === "Backspace") {
          if (removeMentionChipBeforeCaret(editor)) {
            e.preventDefault();
            handleInput();
            return;
          }
        }

        if (isMentionTerminator(e.key)) {
          if (terminatorHandledRef.current) {
            terminatorHandledRef.current = false;
            return;
          }
          if (processMentionTerminator(e.key, editor)) {
            e.preventDefault();
          }
          return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          onSubmit?.();
        }
      },
      [
        applyMention,
        closeSuggest,
        disabled,
        handleInput,
        onSubmit,
        suggestIndex,
        suggestItems,
        suggestOpen,
        processMentionTerminator,
        syncPlainText,
      ],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => editorRef.current?.focus(),
        clear: () => {
          const editor = editorRef.current;
          if (!editor) return;
          editor.innerHTML = "";
          searchCacheRef.current = null;
          closeSuggest();
          syncPlainText();
        },
        insertMention: (username: string, suffix = "") => {
          const editor = editorRef.current;
          if (!editor) return;
          const resolved = findKnownUsername(username, localUsersRef.current);
          if (!resolved || !isExactMentionMatch(username, resolved)) return;
          insertMentionChipAtCaret(editor, resolved, styles.mentionChip, suffix);
          closeSuggest();
          syncPlainText();
        },
        insertText: (text: string) => {
          const editor = editorRef.current;
          if (!editor) return;
          insertTextAtCaret(editor, text);
          syncPlainText();
        },
        getPlainText: () => (editorRef.current ? editorToPlainText(editorRef.current) : ""),
        isEmpty: () => (editorRef.current ? isEditorEmpty(editorRef.current) : true),
      }),
      [closeSuggest, syncPlainText],
    );

    useEffect(() => {
      if (!suggestOpen) return;
      const onDoc = (ev: MouseEvent) => {
        const t = ev.target as Node;
        if (suggestRef.current?.contains(t)) return;
        if (editorRef.current?.contains(t)) return;
        closeSuggest();
      };
      document.addEventListener("mousedown", onDoc);
      return () => document.removeEventListener("mousedown", onDoc);
    }, [closeSuggest, suggestOpen]);

    return (
      <div className={styles.composerInputRow}>
        <div
          ref={editorRef}
          className={styles.composerEditor}
          contentEditable={disabled ? "false" : "true"}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          data-placeholder={placeholder ?? ""}
          suppressContentEditableWarning
          onBeforeInput={handleBeforeInput}
          onInput={handleInput}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onClick={refreshMentionSuggest}
        />
        {suggestOpen && suggestStyle && suggestItems.length > 0 ? (
          <ul
            ref={suggestRef}
            className={styles.mentionSuggest}
            role="listbox"
            aria-label="Подсказки никнеймов"
            style={{ top: suggestStyle.top, left: suggestStyle.left }}
          >
            {suggestItems.map((u, index) => (
              <li key={u.username} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={index === suggestIndex}
                  className={`${styles.mentionSuggestItem}${index === suggestIndex ? ` ${styles.mentionSuggestItemActive}` : ""}`}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    applyMention(u.username);
                  }}
                >
                  <span className={styles.mentionSuggestHandle}>{formatAtHandle(u.username)}</span>
                  {u.displayName.trim() ? (
                    <span className={styles.mentionSuggestName}>{u.displayName.trim()}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  },
);
