"use client";

import { useEffect } from "react";

function revealFonts() {
  const b = document.body;
  if (!b) return;
  b.classList.remove("fonts-pending");
  b.classList.add("fonts-ready");
}

/** Снимает `fonts-pending` после document.fonts.ready — без next/script в теле (React 19 / гидратация). */
export function FontReadyGate() {
  useEffect(() => {
    const fallback = window.setTimeout(revealFonts, 2500);
    if (document.fonts?.ready) {
      void document.fonts.ready.then(
        () => {
          window.clearTimeout(fallback);
          revealFonts();
        },
        () => {
          window.clearTimeout(fallback);
          revealFonts();
        }
      );
    } else {
      window.clearTimeout(fallback);
      revealFonts();
    }
    return () => window.clearTimeout(fallback);
  }, []);
  return null;
}
