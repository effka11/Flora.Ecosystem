"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./addTrackUpload.module.css";

type Option = {
  id: string;
  label: string;
};

type AddTrackSimpleSelectProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
};

export function AddTrackSimpleSelect({
  id,
  value,
  onChange,
  options,
  placeholder = "Выберите",
}: AddTrackSimpleSelectProps) {
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const selectedOption = options.find((opt) => opt.id === value);

  const closeMenu = () => {
    setOpen(false);
  };

  const openMenu = () => {
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

  const selectOption = (optId: string) => {
    onChange(optId);
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
            selectedOption
              ? styles.addTrackGenreTriggerValue
              : styles.addTrackGenreTriggerPlaceholder
          }
        >
          {selectedOption?.label ?? placeholder}
        </span>
      </button>
      {open ? (
        <div id={menuId} className={styles.addTrackGenreMenu} role="listbox">
          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="option"
              aria-selected={value === opt.id}
              className={`${styles.addTrackGenreMenuItem} flora-type-15${
                value === opt.id ? ` ${styles.addTrackGenreMenuItemActive}` : ""
              }`}
              onClick={() => selectOption(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
