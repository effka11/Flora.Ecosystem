"use client";

import {
  CHAT_LIST_ARCHIVE_FOLDER_ID,
  orderChatListFolders,
  type ChatListFolderDef,
  type ChatListFolderId,
} from "@flora/client-core/messaging";
import { renderChatFolderIcon } from "./chatFolderIcons";
import styles from "./messages.module.css";

/** Ширина слота иконки в первичных клетках. */
const FOLDER_ICON_SLOT_COLS = 2;
/** Шаг между центрами/левыми краями: слот 2 + зазор 2 → визуально ~3 клетки между глифами. */
const FOLDER_ICON_PITCH_COLS = 4;
/**
 * «+» центром на 88.5; папки — pitch 4, +1 клетка отступа от «+».
 * fromRight=0 → центр 83.5 (left 82.5 при width 2).
 */
const PLUS_CENTER_COL = 88.5;
/** Доп. отступ от центра «+» до первой папки (сверх pitch). */
const PLUS_TO_FOLDER_GAP_EXTRA_COLS = 1;
const CONTENT_ORIGIN_COL = 37;

/** Как Mobile `resolveFolderIcon`: archive / group / folder.icon / folder-outline. */
function resolveIconName(folder: ChatListFolderDef): string {
  if (folder.id === CHAT_LIST_ARCHIVE_FOLDER_ID) return "archive-outline";
  if (folder.kind === "group") return "people-outline";
  if (folder.icon?.trim()) return folder.icon.trim();
  return "folder-outline";
}

type Props = {
  folders: readonly ChatListFolderDef[];
  activeFolder: ChatListFolderId;
  onSelect: (folder: ChatListFolderId) => void;
  onDeleteFolder?: (folderId: string) => void;
};

/**
 * Иконки папок на горизонтали 7.
 * Порядок справа налево: «+»(центр 88.5) → Архив(83.5) → кастомные.
 * Глифы — паритет Mobile Ionicons по `folder.icon`.
 */
export function MessagesChatFolders({ folders, activeFolder, onSelect, onDeleteFolder }: Props) {
  const ordered = orderChatListFolders(folders);
  if (ordered.length === 0) return null;

  return (
    <nav className={styles.messagesChatFolders} aria-label="Папки чатов">
      {ordered.map((folder, index) => {
        // fromRight=0 — ближайшая к «+» (Архив, если есть).
        const fromRight = ordered.length - 1 - index;
        const centerCol =
          PLUS_CENTER_COL -
          PLUS_TO_FOLDER_GAP_EXTRA_COLS -
          (fromRight + 1) * FOLDER_ICON_PITCH_COLS;
        // width 2 → left = center - 1
        const leftCol = centerCol - FOLDER_ICON_SLOT_COLS / 2;
        const active = activeFolder === folder.id;
        const canDelete = folder.id !== CHAT_LIST_ARCHIVE_FOLDER_ID;
        return (
          <button
            key={folder.id}
            type="button"
            title={folder.label}
            aria-label={folder.label}
            aria-pressed={active}
            className={`${styles.messagesChatFolderBtn}${active ? ` ${styles.messagesChatFolderBtnActive}` : ""}`}
            style={{
              left: `calc((${leftCol} - ${CONTENT_ORIGIN_COL}) * var(--flora-grid-step))`,
              width: `calc(${FOLDER_ICON_SLOT_COLS} * var(--flora-grid-step))`,
            }}
            onClick={() => onSelect(active ? "all" : folder.id)}
            onContextMenu={
              canDelete && onDeleteFolder
                ? (event) => {
                    event.preventDefault();
                    if (window.confirm(`Удалить папку «${folder.label}»? Чаты останутся в списке.`)) {
                      onDeleteFolder(folder.id);
                    }
                  }
                : undefined
            }
          >
            {renderChatFolderIcon(resolveIconName(folder))}
            {active ? <span className={styles.messagesChatFolderUnderline} aria-hidden /> : null}
          </button>
        );
      })}
    </nav>
  );
}
