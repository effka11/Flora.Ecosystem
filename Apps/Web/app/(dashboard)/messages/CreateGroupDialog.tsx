"use client";

import { useMemo, useState } from "react";
import type { ConversationListItemDto } from "@/lib/socialApi";
import { GROUP_CHAT_MAX_MEMBERS } from "./groupConversationTypes";
import styles from "./messages.module.css";

export type CreateGroupDialogResult = {
  title: string;
  memberUserUuids: string[];
};

type Props = {
  open: boolean;
  conversations: readonly ConversationListItemDto[];
  onClose: () => void;
  /** Return true to close the dialog after create. */
  onCreate: (result: CreateGroupDialogResult) => boolean;
};

/** Max peers selectable (creator is added separately → total ≤ GROUP_CHAT_MAX_MEMBERS). */
const MAX_PEER_SELECTION = GROUP_CHAT_MAX_MEMBERS - 1;

function CreateGroupDialogForm({
  conversations,
  onClose,
  onCreate,
}: Omit<Props, "open">) {
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = conversations.filter((c) => c.otherUserUuid);
    if (!q) return list;
    return list.filter((c) => {
      const display = (c.otherDisplayName || "").toLowerCase();
      const user = (c.otherUsername || "").toLowerCase();
      return display.includes(q) || user.includes(q);
    });
  }, [conversations, query]);

  const toggle = (uuid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        if (next.size >= MAX_PEER_SELECTION) {
          setError(`Не больше ${MAX_PEER_SELECTION} участников кроме вас.`);
          return prev;
        }
        next.add(uuid);
      }
      return next;
    });
    setError(null);
  };

  const submit = () => {
    const members = [...selected];
    if (members.length === 0) {
      setError("Выберите хотя бы одного участника.");
      return;
    }
    const ok = onCreate({
      title: title.trim() || "Группа",
      memberUserUuids: members,
    });
    if (ok) onClose();
  };

  return (
    <div className={styles.messagesFolderDialogBackdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.messagesFolderDialog}
        role="dialog"
        aria-modal
        aria-label="Новая группа"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.messagesFolderDialogHeader}>
          <button type="button" className={styles.messagesFolderDialogGhost} onClick={onClose}>
            Закрыть
          </button>
          <h2 className={styles.messagesFolderDialogTitle}>Новая группа</h2>
          <button type="button" className={styles.messagesFolderDialogAction} onClick={submit}>
            Создать
          </button>
        </header>

        <label className={styles.messagesFolderDialogField}>
          <span>Название</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={40}
            placeholder="Например, Команда"
          />
        </label>

        <label className={styles.messagesFolderDialogField}>
          <span>Участники</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по имени или @username"
            autoCapitalize="off"
            autoCorrect="off"
            disabled={conversations.length === 0}
          />
        </label>

        <ul className={styles.messagesFolderDialogUsers}>
          {conversations.length === 0 ? (
            <li className={styles.messagesFolderDialogEmpty}>
              Нет диалогов для выбора. Найдите человека во вкладке «Люди».
            </li>
          ) : candidates.length === 0 ? (
            <li className={styles.messagesFolderDialogEmpty}>Никого не найдено.</li>
          ) : (
            candidates.map((c) => {
              const checked = selected.has(c.otherUserUuid);
              const label = c.otherDisplayName || c.otherUsername;
              return (
                <li key={c.otherUserUuid}>
                  <button
                    type="button"
                    className={`${styles.messagesFolderDialogUser}${
                      checked ? ` ${styles.messagesFolderDialogUserActive}` : ""
                    }`}
                    onClick={() => toggle(c.otherUserUuid)}
                    aria-pressed={checked}
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

        {error ? <p className={styles.messagesFolderDialogError}>{error}</p> : null}
      </div>
    </div>
  );
}

export function CreateGroupDialog({ open, conversations, onClose, onCreate }: Props) {
  if (!open) return null;
  return (
    <CreateGroupDialogForm
      conversations={conversations}
      onClose={onClose}
      onCreate={onCreate}
    />
  );
}
