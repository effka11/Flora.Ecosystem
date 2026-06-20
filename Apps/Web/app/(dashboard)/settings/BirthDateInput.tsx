"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  birthDateDigitsToIso,
  filterBirthDateDigits,
  formatBirthDateDigits,
  getBirthDateMaxIso,
  isoToBirthDateDigits,
  isBirthDateDigitsComplete,
} from "./birthDateMask";
import styles from "./settings.module.css";

type BirthDateInputProps = {
  id?: string;
  value: string;
  onChange: (isoValue: string) => void;
  className?: string;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUMPAD_DIGIT_CODE_RE = /^Numpad([0-9])$/;
const NAVIGATION_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

function digitFromKeyboardEvent(event: React.KeyboardEvent): string | null {
  const numpadMatch = NUMPAD_DIGIT_CODE_RE.exec(event.code);
  if (numpadMatch) return numpadMatch[1];

  if (event.key.length === 1 && /^\d$/.test(event.key)) return event.key;

  return null;
}

export function BirthDateInput({ id, value, onChange, className }: BirthDateInputProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const calendarId = `${inputId}-calendar`;

  const calendarRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [digits, setDigits] = useState(() => isoToBirthDateDigits(value));
  const [focused, setFocused] = useState(false);

  const moveCaretToEnd = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  useEffect(() => {
    if (!focused) {
      setDigits(isoToBirthDateDigits(value));
    }
  }, [focused, value]);

  const displayValue = formatBirthDateDigits(digits);

  useEffect(() => {
    if (!focused) return;
    requestAnimationFrame(moveCaretToEnd);
  }, [focused, displayValue, moveCaretToEnd]);

  const applyDigits = useCallback(
    (nextDigits: string, commit: boolean, previousDigits: string) => {
      const normalized = filterBirthDateDigits(nextDigits, previousDigits);
      setDigits(normalized);

      if (!commit) return;

      if (!normalized.length) {
        onChange("");
        return;
      }

      if (!isBirthDateDigitsComplete(normalized)) return;

      const iso = birthDateDigitsToIso(normalized);
      onChange(iso ?? "");
    },
    [onChange],
  );

  const onTextInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value.replace(/\D/g, "").slice(0, 8);
      const nextDigits = filterBirthDateDigits(raw, digits);
      const commit = nextDigits.length === 0 || isBirthDateDigitsComplete(nextDigits);
      applyDigits(nextDigits, commit, digits);
    },
    [applyDigits, digits],
  );

  const onTextFocus = useCallback(() => {
    setFocused(true);
    requestAnimationFrame(moveCaretToEnd);
  }, [moveCaretToEnd]);

  const onTextMouseDown = useCallback(
    (event: React.MouseEvent<HTMLInputElement>) => {
      event.preventDefault();
      event.currentTarget.focus();
      requestAnimationFrame(moveCaretToEnd);
    },
    [moveCaretToEnd],
  );

  const onTextSelect = useCallback(() => {
    moveCaretToEnd();
  }, [moveCaretToEnd]);

  const appendDigit = useCallback(
    (digit: string) => {
      const nextDigits = filterBirthDateDigits(`${digits}${digit}`, digits);
      const commit = nextDigits.length === 0 || isBirthDateDigitsComplete(nextDigits);
      applyDigits(nextDigits, commit, digits);
    },
    [applyDigits, digits],
  );

  const removeLastDigit = useCallback(() => {
    const nextDigits = digits.slice(0, -1);
    const commit = nextDigits.length === 0 || isBirthDateDigitsComplete(nextDigits);
    applyDigits(nextDigits, commit, digits);
  }, [applyDigits, digits]);

  const onTextKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const digit = digitFromKeyboardEvent(event);
      if (digit !== null) {
        event.preventDefault();
        appendDigit(digit);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        removeLastDigit();
        return;
      }

      if (event.code === "NumpadDecimal" || event.key === "Decimal") {
        event.preventDefault();
        return;
      }

      if (NAVIGATION_KEYS.has(event.key) && !NUMPAD_DIGIT_CODE_RE.test(event.code)) {
        event.preventDefault();
        moveCaretToEnd();
      }
    },
    [appendDigit, moveCaretToEnd, removeLastDigit],
  );

  const onTextBlur = useCallback(() => {
    setFocused(false);
    if (!digits.length) {
      onChange("");
      return;
    }
    if (!isBirthDateDigitsComplete(digits)) {
      setDigits(isoToBirthDateDigits(value));
      return;
    }
    const iso = birthDateDigitsToIso(digits);
    if (!iso) {
      setDigits(isoToBirthDateDigits(value));
      return;
    }
    onChange(iso);
  }, [digits, onChange, value]);

  const openCalendar = useCallback(() => {
    const el = calendarRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") {
      el.showPicker();
      return;
    }
    el.click();
  }, []);

  const onCalendarChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const iso = event.target.value;
      if (!iso) return;
      const nextDigits = isoToBirthDateDigits(iso);
      if (!birthDateDigitsToIso(nextDigits)) return;
      onChange(iso);
      setDigits(nextDigits);
    },
    [onChange],
  );

  const birthDateMaxIso = getBirthDateMaxIso();

  const calendarValue =
    (isBirthDateDigitsComplete(digits) ? birthDateDigitsToIso(digits) : null) ??
    (ISO_DATE_RE.test(value) ? value : "");

  return (
    <div className={styles.birthDateField}>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        inputMode="numeric"
        autoComplete="bday"
        className={className ?? styles.input}
        placeholder="__.__.____"
        value={displayValue}
        onFocus={onTextFocus}
        onMouseDown={onTextMouseDown}
        onSelect={onTextSelect}
        onKeyDown={onTextKeyDown}
        onBlur={onTextBlur}
        onChange={onTextInput}
        aria-describedby={calendarId}
        maxLength={10}
      />
      <button
        type="button"
        className={styles.birthDateCalendarBtn}
        onClick={openCalendar}
        aria-label="Выбрать дату в календаре"
        title="Календарь"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>
      <input
        ref={calendarRef}
        id={calendarId}
        type="date"
        className={styles.visuallyHidden}
        value={calendarValue}
        max={birthDateMaxIso}
        onChange={onCalendarChange}
        tabIndex={-1}
        aria-hidden
      />
    </div>
  );
}
