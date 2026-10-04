"use client";

import { useMemo, useRef } from "react";
import styles from "./compose.module.css";
import {
  buildComposeDraftsFlipStructureKey,
  useComposeDraftsSidebarFlip,
} from "./useComposeDraftsSidebarFlip";

export const COMPOSE_MAX_DRAFTS = 15;
export const COMPOSE_DRAFT_LABEL_MAX_LEN = 50;

export function normalizeComposeDraftLabel(label: string): string {
  return label.trim().slice(0, COMPOSE_DRAFT_LABEL_MAX_LEN);
}

export type ComposeDraft = {
  id: string;
  label: string;
  body: string;
};

type ComposeDraftsSidebarProps = {
  composeScopeId: string;
  drafts: ComposeDraft[];
  activeDraftId: string;
  canAddDraft: boolean;
  canDeleteDraft: boolean;
  onDraftSelect: (id: string) => void;
  onAddDraft: () => void;
  onReturnToNeutral: () => void;
  onEditDraft: (id: string) => void;
  onDeleteDraft: (id: string) => void;
};

function IconEdit() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M10 11v6M14 11v6" />
      <path d="M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" />
    </svg>
  );
}

export function ComposeDraftsSidebar({
  composeScopeId,
  drafts,
  activeDraftId,
  canAddDraft,
  canDeleteDraft,
  onDraftSelect,
  onAddDraft,
  onReturnToNeutral,
  onEditDraft,
  onDeleteDraft,
}: ComposeDraftsSidebarProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const flipStructureKey = useMemo(
    () =>
      buildComposeDraftsFlipStructureKey(
        composeScopeId,
        drafts.map((draft) => draft.id),
        canAddDraft,
      ),
    [composeScopeId, drafts, canAddDraft],
  );
  useComposeDraftsSidebarFlip(listRef, flipStructureKey);

  return (
    <aside className={styles.composeDraftsSidebar} aria-label="Черновики">
      <nav className={styles.composeDraftsSidebarNav}>
        <ul ref={listRef} className={styles.composeDraftsNavList}>
          {drafts.map((draft) => {
            const active = draft.id === activeDraftId;
            return (
              <li key={draft.id} className={styles.composeDraftRow} data-compose-flip-key={draft.id}>
                <button
                  type="button"
                  className={`${styles.composeDraftNavItem} ${active ? styles.composeDraftNavItemActive : ""}`}
                  onClick={() => onDraftSelect(draft.id)}
                  aria-current={active ? "true" : undefined}
                  title={draft.label}
                >
                  <span className={styles.composeDraftNavLabel}>{draft.label}</span>
                </button>
                <div className={styles.composeDraftRowActions}>
                  <button
                    type="button"
                    className={styles.composeDraftActionBtn}
                    aria-label={`Переименовать «${draft.label}»`}
                    onClick={() => onEditDraft(draft.id)}
                  >
                    <IconEdit />
                  </button>
                  {canDeleteDraft ? (
                    <button
                      type="button"
                      className={`${styles.composeDraftActionBtn} ${styles.composeDraftActionBtnDanger}`}
                      aria-label={`Удалить «${draft.label}»`}
                      onClick={() => onDeleteDraft(draft.id)}
                    >
                      <IconTrash />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
          <li
            data-compose-flip-key="footer"
            className={`${styles.composeDraftsFooter}${drafts.length === 0 ? ` ${styles.composeDraftsFooterFlush}` : ""}`}
          >
            <ul className={styles.composeDraftsFooterList}>
              {canAddDraft ? (
                <li>
                  <button
                    type="button"
                    className={`${styles.composeDraftNavItem} ${styles.composeDraftAddNavItem}`}
                    onClick={onAddDraft}
                    aria-label="Новый черновик"
                  >
                    Новый черновик
                  </button>
                </li>
              ) : null}
              <li>
                <button
                  type="button"
                  className={`${styles.composeDraftNavItem} ${styles.composeDraftReturnNavItem}`}
                  onClick={onReturnToNeutral}
                  aria-label="Вернуться к нейтральному посту"
                >
                  Вернуться
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </nav>
    </aside>
  );
}
