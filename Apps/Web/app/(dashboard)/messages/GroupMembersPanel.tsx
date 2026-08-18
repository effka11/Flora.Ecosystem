"use client";

import { useEffect, useMemo, useState } from "react";
import type { ConversationListItemDto } from "@/lib/socialApi";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import {
  formatGroupMembersLabel,
  GROUP_CHAT_MAX_MEMBERS,
  type GroupMember,
} from "./groupConversationTypes";
import styles from "./messages.module.css";

type Props = {
  open: boolean;
  title: string;
  members: readonly GroupMember[];
  /** Current viewer uuid (lowercase-insensitive compare). */
  meUserUuid: string;
  isCreator: boolean;
  /** DM peers available to add (creator only). */
  addCandidates: readonly ConversationListItemDto[];
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSaveTitle?: (title: string) => Promise<boolean>;
  onRemoveMember?: (userUuid: string) => Promise<boolean>;
  onAddMember?: (userUuid: string) => Promise<boolean>;
};

export function GroupMembersPanel({
  open,
  title,
  members,
  meUserUuid,
  isCreator,
  addCandidates,
  busy = false,
  error = null,
  onClose,
  onSaveTitle,
  onRemoveMember,
  onAddMember,
}: Props) {
  const [draftTitle, setDraftTitle] = useState(title);
  const [addQuery, setAddQuery] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraftTitle(title);
    setAddQuery("");
    setLocalError(null);
  }, [open, title]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, busy]);

  const meNorm = meUserUuid.trim().toLowerCase();
  const memberSet = useMemo(
    () => new Set(members.map((m) => m.userUuid.trim().toLowerCase()).filter(Boolean)),
    [members],
  );

  const filteredAdd = useMemo(() => {
    if (!isCreator) return [];
    const q = addQuery.trim().toLowerCase();
    return addCandidates.filter((c) => {
      const uuid = c.otherUserUuid.trim().toLowerCase();
      if (!uuid || memberSet.has(uuid)) return false;
      if (!q) return true;
      const display = (c.otherDisplayName || "").toLowerCase();
      const user = (c.otherUsername || "").toLowerCase();
      return display.includes(q) || user.includes(q);
    });
  }, [addCandidates, addQuery, isCreator, memberSet]);

  const titleDirty = draftTitle.trim() !== title.trim();
  const atCapacity = members.length >= GROUP_CHAT_MAX_MEMBERS;
  const displayError = localError || error;

  if (!open) return null;

  const saveTitle = () => {
    if (!isCreator || !onSaveTitle || busy) return;
    const next = draftTitle.trim();
    if (!next) {
      setLocalError("Название не может быть пустым.");
      return;
    }
    setLocalError(null);
    void (async () => {
      const ok = await onSaveTitle(next);
      if (!ok) setLocalError("Не удалось сохранить название.");
    })();
  };

  return (
    <div
      className={styles.messagesFolderDialogBackdrop}
      role="presentation"
      onClick={busy ? undefined : onClose}
    >
      <div
        className={styles.messagesFolderDialog}
        role="dialog"
        aria-modal
        aria-label={`Участники — ${title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.messagesFolderDialogHeader}>
          <button
            type="button"
            className={styles.messagesFolderDialogGhost}
            onClick={onClose}
            disabled={busy}
          >
            Закрыть
          </button>
          <h2 className={styles.messagesFolderDialogTitle}>
            {formatGroupMembersLabel(members.length)}
          </h2>
          {isCreator && titleDirty ? (
            <button
              type="button"
              className={styles.messagesFolderDialogAction}
              onClick={saveTitle}
              disabled={busy}
            >
              {busy ? "…" : "Сохранить"}
            </button>
          ) : (
            <span
              className={styles.messagesFolderDialogAction}
              aria-hidden
              style={{ visibility: "hidden" }}
            >
              —
            </span>
          )}
        </header>

        {isCreator ? (
          <label className={styles.messagesFolderDialogField}>
            <span>Название</span>
            <input
              value={draftTitle}
              onChange={(event) => {
                setDraftTitle(event.target.value);
                setLocalError(null);
              }}
              maxLength={40}
              disabled={busy}
              aria-label="Название группы"
            />
          </label>
        ) : (
          <p className={styles.groupMembersTitleReadonly}>{title}</p>
        )}

        <ul className={styles.groupMembersList}>
          {members.map((member) => {
            const label = member.displayName || member.username;
            const memberNorm = member.userUuid.trim().toLowerCase();
            const isMe = memberNorm === meNorm;
            const canKick = isCreator && !isMe && Boolean(onRemoveMember);
            return (
              <li key={member.userUuid} className={styles.groupMembersRow}>
                <FloraAvatar
                  plain
                  size={45}
                  displayName={member.displayName || member.username}
                  username={member.username}
                  seed={member.userUuid}
                  avatarUuid={member.avatarUuid}
                  accountBlocked={member.accountBlocked}
                />
                <div className={styles.groupMembersBody}>
                  <span className={styles.groupMembersName}>
                    {label}
                    {isMe ? " (вы)" : ""}
                  </span>
                  <span className={styles.groupMembersHandle}>
                    @{member.username.replace(/^@+/, "") || "…"}
                  </span>
                </div>
                {canKick ? (
                  <button
                    type="button"
                    className={styles.groupMembersRemove}
                    disabled={busy}
                    onClick={() => {
                      setLocalError(null);
                      void (async () => {
                        const ok = await onRemoveMember!(member.userUuid);
                        if (!ok) setLocalError("Не удалось удалить участника.");
                      })();
                    }}
                  >
                    Удалить
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>

        {isCreator && onAddMember ? (
          <>
            <label className={styles.messagesFolderDialogField}>
              <span>Добавить участника</span>
              <input
                value={addQuery}
                onChange={(event) => setAddQuery(event.target.value)}
                placeholder={atCapacity ? "Группа заполнена" : "Поиск по имени или @username"}
                disabled={busy || atCapacity || addCandidates.length === 0}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            {!atCapacity ? (
              <ul className={styles.groupMembersAddList}>
                {addCandidates.length === 0 ? (
                  <li className={styles.messagesFolderDialogEmpty}>
                    Нет диалогов для выбора. Найдите человека во вкладке «Люди».
                  </li>
                ) : filteredAdd.length === 0 ? (
                  <li className={styles.messagesFolderDialogEmpty}>Никого не найдено.</li>
                ) : (
                  filteredAdd.slice(0, 24).map((c) => {
                    const label = c.otherDisplayName || c.otherUsername;
                    return (
                      <li key={c.otherUserUuid}>
                        <button
                          type="button"
                          className={styles.messagesFolderDialogUser}
                          disabled={busy}
                          onClick={() => {
                            setLocalError(null);
                            void (async () => {
                              const ok = await onAddMember(c.otherUserUuid);
                              if (!ok) setLocalError("Не удалось добавить участника.");
                            })();
                          }}
                        >
                          <span className={styles.messagesFolderDialogUserName}>{label}</span>
                          <span className={styles.messagesFolderDialogUserHandle}>
                            @{c.otherUsername.replace(/^@+/, "")}
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            ) : null}
          </>
        ) : null}

        {displayError ? (
          <p className={styles.messagesFolderDialogError} role="alert">
            {displayError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
