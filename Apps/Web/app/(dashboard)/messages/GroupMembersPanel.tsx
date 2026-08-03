"use client";

import { useEffect } from "react";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import { formatGroupMembersLabel, type GroupMember } from "./groupConversationTypes";
import styles from "./messages.module.css";

type Props = {
  open: boolean;
  title: string;
  members: readonly GroupMember[];
  onClose: () => void;
};

export function GroupMembersPanel({ open, title, members, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.messagesFolderDialogBackdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.messagesFolderDialog}
        role="dialog"
        aria-modal
        aria-label={`Участники — ${title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.messagesFolderDialogHeader}>
          <button type="button" className={styles.messagesFolderDialogGhost} onClick={onClose}>
            Закрыть
          </button>
          <h2 className={styles.messagesFolderDialogTitle}>
            {formatGroupMembersLabel(members.length)}
          </h2>
          <span className={styles.messagesFolderDialogAction} aria-hidden style={{ visibility: "hidden" }}>
            —
          </span>
        </header>

        <ul className={styles.groupMembersList}>
          {members.map((member) => {
            const label = member.displayName || member.username;
            return (
              <li key={member.userUuid} className={styles.groupMembersRow}>
                <FloraAvatar
                  plain
                  size={45}
                  displayName={member.displayName || member.username}
                  username={member.username}
                  seed={member.userUuid}
                />
                <div className={styles.groupMembersBody}>
                  <span className={styles.groupMembersName}>{label}</span>
                  <span className={styles.groupMembersHandle}>
                    @{member.username.replace(/^@+/, "") || "…"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
