"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  GenreArtPop,
  GenreArtHipHop,
  GenreArtRock,
  GenreArtElectronics,
  GenreArtInstrumental,
  GenreArtJazz,
  GenreArtFolk,
  GenreArtRnB,
} from "@/app/(dashboard)/music/GenreArts";
import { MUSIC_GENRES } from "@/app/(dashboard)/music/musicGenres";
import styles from "./music.module.css";

type GenreVariant =
  | "genreCardPop"
  | "genreCardHipHop"
  | "genreCardRock"
  | "genreCardElectronics"
  | "genreCardInstrumental"
  | "genreCardJazz"
  | "genreCardFolk"
  | "genreCardRnB";

const GENRE_ARTS: Record<string, { Art: typeof GenreArtPop; variant: GenreVariant }> = {
  pop: { Art: GenreArtPop, variant: "genreCardPop" },
  hiphop: { Art: GenreArtHipHop, variant: "genreCardHipHop" },
  electronics: { Art: GenreArtElectronics, variant: "genreCardElectronics" },
  rock: { Art: GenreArtRock, variant: "genreCardRock" },
  instrumental: { Art: GenreArtInstrumental, variant: "genreCardInstrumental" },
  jazz: { Art: GenreArtJazz, variant: "genreCardJazz" },
  folk: { Art: GenreArtFolk, variant: "genreCardFolk" },
  rnb: { Art: GenreArtRnB, variant: "genreCardRnB" },
};

const GENRES = MUSIC_GENRES.map((genre) => ({
  ...genre,
  ...GENRE_ARTS[genre.id]!,
}));

const VISIBLE_GENRE_COUNT = 4;
const SCROLL_EDGE_EPS = 2;

type ScrollArrows = { canScrollLeft: boolean; canScrollRight: boolean };

function GenresNavChevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      className={styles.genresNavIcon}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d={direction === "left" ? "M14.5 6.5 9 12l5.5 5.5" : "M9.5 6.5 15 12l-5.5 5.5"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getCardSnapOffsets(scrollEl: HTMLElement): number[] {
  const grid = scrollEl.querySelector(":scope > div");
  if (!grid) return [0];
  return Array.from(grid.children).map((node) => Math.round((node as HTMLElement).offsetLeft));
}

/** Позиции «страниц»: первая карточка и первая карточка последнего экрана (4 из 8). */
function getPageOffsets(scrollEl: HTMLElement): number[] {
  const snaps = getCardSnapOffsets(scrollEl);
  if (snaps.length === 0) return [0];
  const lastPageIndex = Math.max(0, GENRES.length - VISIBLE_GENRE_COUNT);
  const indices = [0, lastPageIndex].filter((idx, i, arr) => i === 0 || idx !== arr[0]);
  const offsets = indices.map((idx) => snaps[Math.min(idx, snaps.length - 1)] ?? 0);
  return [...new Set(offsets)].sort((a, b) => a - b);
}

function getCurrentPageIndex(pageOffsets: number[], scrollLeft: number): number {
  let index = 0;
  for (let i = 0; i < pageOffsets.length; i++) {
    if (pageOffsets[i] <= scrollLeft + SCROLL_EDGE_EPS) index = i;
  }
  return index;
}

function readScrollArrows(el: HTMLElement, scrollLeft = el.scrollLeft): ScrollArrows {
  const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
  return {
    canScrollLeft: scrollLeft > SCROLL_EDGE_EPS,
    canScrollRight: maxScroll > SCROLL_EDGE_EPS && scrollLeft < maxScroll - SCROLL_EDGE_EPS,
  };
}

function predictAfterNavClick(scrollEl: HTMLElement, direction: -1 | 1) {
  const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
  const pageOffsets = getPageOffsets(scrollEl);
  const pageIndex = getCurrentPageIndex(pageOffsets, scrollEl.scrollLeft);

  if (direction > 0) {
    const nextIndex = Math.min(pageIndex + 1, pageOffsets.length - 1);
    const targetLeft = Math.min(pageOffsets[nextIndex] ?? maxScroll, maxScroll);
    const isLastPage = nextIndex >= pageOffsets.length - 1;
    return {
      targetLeft,
      arrows: {
        canScrollLeft: targetLeft > SCROLL_EDGE_EPS,
        canScrollRight: !isLastPage,
      },
    };
  }

  const nextIndex = Math.max(pageIndex - 1, 0);
  const targetLeft = pageOffsets[nextIndex] ?? 0;
  const isFirstPage = nextIndex <= 0;
  return {
    targetLeft,
    arrows: {
      canScrollLeft: !isFirstPage,
      canScrollRight: maxScroll > SCROLL_EDGE_EPS,
    },
  };
}

function paintNavBtn(btn: HTMLButtonElement | null, active: boolean) {
  if (!btn) return;
  const inactiveClass = styles.genresNavBtnInactive;

  if (active) {
    btn.classList.remove(inactiveClass);
    btn.removeAttribute("aria-disabled");
    return;
  }

  btn.classList.add(inactiveClass);
  btn.setAttribute("aria-disabled", "true");
}

export function GenresCarousel() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const leftBtnRef = useRef<HTMLButtonElement>(null);
  const rightBtnRef = useRef<HTMLButtonElement>(null);
  const scrollTargetRef = useRef<number | null>(null);
  const scrollLockRef = useRef(false);

  const [arrows, setArrows] = useState<ScrollArrows>({ canScrollLeft: false, canScrollRight: false });
  const [fadeLeft, setFadeLeft] = useState(false);
  const [fadeRight, setFadeRight] = useState(false);

  const leftActive = !fadeLeft && arrows.canScrollLeft;
  const rightActive = !fadeRight && arrows.canScrollRight;

  const commitArrows = useCallback((next: ScrollArrows) => {
    setArrows(next);
  }, []);

  const syncFromDom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || scrollLockRef.current) return;
    const next = readScrollArrows(el);
    commitArrows(next);
    paintNavBtn(leftBtnRef.current, next.canScrollLeft);
    paintNavBtn(rightBtnRef.current, next.canScrollRight);
  }, [commitArrows]);

  const releaseScrollLock = useCallback(() => {
    scrollLockRef.current = false;
    scrollTargetRef.current = null;
    setFadeLeft(false);
    setFadeRight(false);
    const el = scrollRef.current;
    if (!el) return;
    const next = readScrollArrows(el);
    commitArrows(next);
    paintNavBtn(leftBtnRef.current, next.canScrollLeft);
    paintNavBtn(rightBtnRef.current, next.canScrollRight);
  }, [commitArrows]);

  useEffect(() => {
    syncFromDom();
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = () => {
      if (!scrollLockRef.current) return;
      releaseScrollLock();
    };

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncFromDom) : null;
    ro?.observe(el);
    window.addEventListener("resize", syncFromDom);
    el.addEventListener("scrollend", releaseScrollLock);
    el.addEventListener("wheel", onWheel, { passive: true });

    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", syncFromDom);
      el.removeEventListener("scrollend", releaseScrollLock);
      el.removeEventListener("wheel", onWheel);
    };
  }, [syncFromDom, releaseScrollLock]);

  const runScrollToTarget = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    if (direction < 0 && !arrows.canScrollLeft) return;
    if (direction > 0 && !arrows.canScrollRight) return;

    const { targetLeft, arrows: predicted } = predictAfterNavClick(el, direction);
    scrollTargetRef.current = targetLeft;
    scrollLockRef.current = true;

    flushSync(() => {
      commitArrows(predicted);
      setFadeLeft(!predicted.canScrollLeft);
      setFadeRight(!predicted.canScrollRight);
      paintNavBtn(leftBtnRef.current, predicted.canScrollLeft);
      paintNavBtn(rightBtnRef.current, predicted.canScrollRight);
    });

    requestAnimationFrame(() => {
      el.scrollTo({ left: targetLeft, behavior: "smooth" });
    });
  };

  const onNavPointerDown = (direction: -1 | 1) => {
    if (direction < 0 && !leftActive) return;
    if (direction > 0 && !rightActive) return;
    runScrollToTarget(direction);
  };

  const onNavClick = (direction: -1 | 1) => {
    if (scrollLockRef.current) return;
    runScrollToTarget(direction);
  };

  return (
    <section className={styles.genresSection} aria-labelledby="music-genres-title">
      <div className={styles.genresSectionHeader}>
        <h2 id="music-genres-title" className={styles.genresSectionTitle}>
          Жанры
        </h2>
        <div className={styles.genresNavGroup}>
          <button
            ref={leftBtnRef}
            type="button"
            className={`${styles.genresNavBtn} ${!leftActive ? styles.genresNavBtnInactive : ""}`}
            aria-label="Предыдущие жанры"
            aria-disabled={!leftActive}
            tabIndex={leftActive ? 0 : -1}
            onPointerDown={() => onNavPointerDown(-1)}
            onClick={() => onNavClick(-1)}
          >
            <GenresNavChevron direction="left" />
          </button>
          <button
            ref={rightBtnRef}
            type="button"
            className={`${styles.genresNavBtn} ${!rightActive ? styles.genresNavBtnInactive : ""}`}
            aria-label="Следующие жанры"
            aria-disabled={!rightActive}
            tabIndex={rightActive ? 0 : -1}
            onPointerDown={() => onNavPointerDown(1)}
            onClick={() => onNavClick(1)}
          >
            <GenresNavChevron direction="right" />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className={styles.genresScroll}>
        <div className={styles.genresGrid}>
          {GENRES.map(({ id, title, Art, variant }) => (
            <Link
              key={id}
              href={`/music/genre/${encodeURIComponent(id)}`}
              className={`${styles.genreCard} ${styles[variant]}`}
            >
              <div className={styles.genreCardBg} />
              <Art className={styles.genreCardArt} />
              <span className={styles.genreCardTitle}>{title}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
