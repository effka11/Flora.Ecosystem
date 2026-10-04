"use client";

import { useEffect, useMemo, useState } from "react";
import type { ConversationListItemDto } from "@/lib/socialApi";
import {
  CHAT_FOLDER_ICON_NAMES,
  renderChatFolderIcon,
  type ChatFolderIconName,
} from "./chatFolderIcons";
import styles from "./messages.module.css";

export type CreateChatFolderDialogResult = {
  name: string;
  /** Ionicon name — как на Mobile / в API. */
  icon: string;
  memberUserUuids: string[];
};

type Props = {
  open: boolean;
  conversations: readonly ConversationListItemDto[];
  onClose: () => void;
  onCreate: (result: CreateChatFolderDialogResult) => void;
};

export function CreateChatFolderDialog({ open, conversations, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<ChatFolderIconName>("folder-outline");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setIcon("folder-outline");
    setSelected(new Set());
    setQuery("");
    setError(null);
  }, [open]);

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

  if (!open) return null;

  const toggle = (uuid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
    setError(null);
  };

  const submit = () => {
    const members = [...selected];
    if (members.length === 0) {
      setError("Выберите хотя бы одного пользователя для папки.");
      return;
    }
    onCreate({
      name: name.trim() || "Папка",
      icon,
      memberUserUuids: members,
    });
    onClose();
  };

  return (
    <div className={styles.messagesFolderDialogBackdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.messagesFolderDialog}
        role="dialog"
        aria-modal
        aria-label="Новая папка"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.messagesFolderDialogHeader}>
          <button type="button" className={styles.messagesFolderDialogGhost} onClick={onClose}>
            Закрыть
          </button>
          <h2 className={styles.messagesFolderDialogTitle}>Новая папка</h2>
          <button type="button" className={styles.messagesFolderDialogAction} onClick={submit}>
            Создать
          </button>
        </header>

        <label className={styles.messagesFolderDialogField}>
          <span>Название</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            placeholder="Например, Работа"
          />
        </label>

        <div className={styles.messagesFolderDialogField}>
          <span>Иконка</span>
          <div className={styles.messagesFolderDialogIcons}>
            {CHAT_FOLDER_ICON_NAMES.map((key) => (
              <button
                key={key}
                type="button"
                title={key.replace(/-outline$/, "")}
                className={`${styles.messagesFolderDialogIconBtn}${
                  icon === key ? ` ${styles.messagesFolderDialogIconBtnActive}` : ""
                }`}
                onClick={() => setIcon(key)}
                aria-label={key}
                aria-pressed={icon === key}
              >
                {renderChatFolderIcon(key)}
              </button>
            ))}
          </div>
        </div>

        <label className={styles.messagesFolderDialogField}>
          <span>Чаты в папке</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по имени или @username"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>

        <ul className={styles.messagesFolderDialogUsers}>
          {candidates.length === 0 ? (
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
