"use client";

import { useEffect, useRef, useState } from "react";

const MODAL_CLOSE_MS = 220;

export function useAnimatedModal() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openModal = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setClosing(false);
    setOpen(true);
  };

  const closeModal = () => {
    if (closing) return;
    setClosing(true);
    timerRef.current = setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, MODAL_CLOSE_MS);
  };

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { open, closing, openModal, closeModal };
}
