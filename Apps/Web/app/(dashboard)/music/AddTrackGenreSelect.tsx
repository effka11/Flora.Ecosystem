"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  findGenreGroupById,
  findSubgenreById,
  MUSIC_GENRE_GROUPS,
} from "./musicGenreOptions";
import styles from "./addTrackUpload.module.css";

type AddTrackGenreSelectProps = {
  id: string;
  value: string;
  onChange: (subgenreId: string) => void;
};

export function AddTrackGenreSelect({
  id,
  value,
  onChange,
}: AddTrackGenreSelectProps) {
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"category" | "subgenre">("category");
  const [pendingCategoryId, setPendingCategoryId] = useState("");

  const selectedSubgenre = value ? findSubgenreById(value) : undefined;
  const pendingGroup = findGenreGroupById(pendingCategoryId);

  const closeMenu = () => {
    setOpen(false);
    setStep("category");
    setPendingCategoryId("");
  };

  const openMenu = () => {
    setStep("category");
    setPendingCategoryId("");
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      closeMenu();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selectCategory = (categoryId: string) => {
    setPendingCategoryId(categoryId);
    setStep("subgenre");
  };

  const selectSubgenre = (subgenreId: string) => {
    onChange(subgenreId);
    closeMenu();
  };

  return (
    <div className={styles.addTrackGenreSelectWrap} ref={wrapRef}>
      <button
        type="button"
        id={id}
        className={styles.addTrackGenreTrigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-open={open ? "" : undefined}
        onClick={() => (open ? closeMenu() : openMenu())}
      >
        <span
          className={
            selectedSubgenre
              ? styles.addTrackGenreTriggerValue
              : styles.addTrackGenreTriggerPlaceholder
          }
        >
          {selectedSubgenre?.label ?? "Выберите поджанр"}
        </span>
      </button>
      {open ? (
        <div id={menuId} className={styles.addTrackGenreMenu} role="listbox">
          {step === "category" ? (
            MUSIC_GENRE_GROUPS.map((group) => (
              <button
                key={group.id}
                type="button"
                role="option"
                className={`${styles.addTrackGenreMenuItem} flora-type-15`}
                onClick={() => selectCategory(group.id)}
              >
                {group.label}
              </button>
            ))
          ) : (
            <>
              <button
                type="button"
                className={`${styles.addTrackGenreMenuBack} flora-type-15`}
                onClick={() => setStep("category")}
              >
                ← {pendingGroup?.label}
              </button>
              {pendingGroup?.subgenres.map((subgenre) => (
                <button
                  key={subgenre.id}
                  type="button"
                  role="option"
                  aria-selected={value === subgenre.id}
                  className={`${styles.addTrackGenreMenuItem} flora-type-15${
                    value === subgenre.id ? ` ${styles.addTrackGenreMenuItemActive}` : ""
                  }`}
                  onClick={() => selectSubgenre(subgenre.id)}
                >
                  {subgenre.label}
                </button>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
