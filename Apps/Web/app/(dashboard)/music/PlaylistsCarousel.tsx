"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { coverColorIdToColor } from "@/app/(dashboard)/music/musicDefaultCovers";
import { formatPlaylistTrackCount, type PlaylistItem } from "@/app/(dashboard)/music/musicPlaylists";
import { invalidateMusicCaches } from "@/lib/dashboardPreload";
import { apiCreateMusicPlaylist } from "@/lib/musicApi";
import styles from "./music.module.css";

const VISIBLE_CARD_COUNT = 4;
const SCROLL_EDGE_EPS = 2;

type ScrollArrows = { canScrollLeft: boolean; canScrollRight: boolean };

function CarouselNavChevron({ direction }: { direction: "left" | "right" }) {
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

function getPageOffsets(scrollEl: HTMLElement, itemCount: number): number[] {
  const snaps = getCardSnapOffsets(scrollEl);
  if (snaps.length === 0) return [0];
  const lastPageIndex = Math.max(0, itemCount - VISIBLE_CARD_COUNT);
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

function predictAfterNavClick(scrollEl: HTMLElement, direction: -1 | 1, itemCount: number) {
  const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
  const pageOffsets = getPageOffsets(scrollEl, itemCount);
  const pageIndex = getCurrentPageIndex(pageOffsets, scrollEl.scrollLeft);

  if (direction > 0) {
    const remaining = maxScroll - scrollEl.scrollLeft;
    const page = scrollEl.clientWidth;
    if (remaining <= page + SCROLL_EDGE_EPS) {
      return {
        targetLeft: maxScroll,
        arrows: {
          canScrollLeft: maxScroll > SCROLL_EDGE_EPS,
          canScrollRight: false,
        },
      };
    }
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

  if (scrollEl.scrollLeft <= scrollEl.clientWidth + SCROLL_EDGE_EPS) {
    return {
      targetLeft: 0,
      arrows: {
        canScrollLeft: false,
        canScrollRight: maxScroll > SCROLL_EDGE_EPS,
      },
    };
  }

  const nextIndex = Math.max(pageIndex - 1, 0);
  const targetLeft = pageOffsets[nextIndex] ?? 0;
  return {
    targetLeft,
    arrows: {
      canScrollLeft: nextIndex > 0,
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

type PlaylistsCarouselProps = {
  playlists: PlaylistItem[];
  onPlaylistsChange?: (playlists: PlaylistItem[]) => void;
};

export function PlaylistsCarousel({ playlists, onPlaylistsChange }: PlaylistsCarouselProps) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const leftBtnRef = useRef<HTMLButtonElement>(null);
  const rightBtnRef = useRef<HTMLButtonElement>(null);
  const scrollTargetRef = useRef<number | null>(null);
  const scrollLockRef = useRef(false);
  const hasEmptyPlaylistCard = playlists.length === 0;
  const itemCount = hasEmptyPlaylistCard ? 1 : playlists.length;

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
  }, [syncFromDom, releaseScrollLock, itemCount]);

  const runScrollToTarget = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    if (direction < 0 && !arrows.canScrollLeft) return;
    if (direction > 0 && !arrows.canScrollRight) return;

    const { targetLeft, arrows: predicted } = predictAfterNavClick(el, direction, itemCount);
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
    if (direction < 0 && !arrows.canScrollLeft) return;
    if (direction > 0 && !arrows.canScrollRight) return;
    runScrollToTarget(direction);
  };

  const openPlaylist = (playlistId: string) => {
    router.push(`/music/playlist/${encodeURIComponent(playlistId)}`, { scroll: false });
  };

  const handleCreatePlaylist = async () => {
    const title = window.prompt("Название плейлиста");
    if (title == null) return;
    const trimmed = title.trim();
    if (!trimmed) return;

    try {
      const playlistId = await apiCreateMusicPlaylist(trimmed);
      invalidateMusicCaches();
      const next: PlaylistItem = {
        id: playlistId,
        title: trimmed,
        trackCount: 0,
        kind: "user",
        variant: "playlistCardUser",
        canDelete: true,
        coverColorId: "forest",
      };
      onPlaylistsChange?.([next, ...playlists]);
      openPlaylist(playlistId);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Не удалось создать плейлист.");
    }
  };

  return (
    <section className={styles.playlistsSection} aria-labelledby="music-playlists-title">
      <div className={styles.genresSectionHeader}>
        <div className={styles.playlistsSectionHeading}>
          <h2 id="music-playlists-title" className={styles.genresSectionTitle}>
            Мои плейлисты
          </h2>
          <button
            type="button"
            className={styles.playlistAddBtn}
            aria-label="Создать плейлист"
            onClick={() => void handleCreatePlaylist()}
          >
            <svg className={styles.playlistAddBtnIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 7.5v9M7.5 12h9"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className={styles.genresNavGroup}>
          <button
            ref={leftBtnRef}
            type="button"
            className={`${styles.genresNavBtn} ${!leftActive ? styles.genresNavBtnInactive : ""}`}
            aria-label="Предыдущие плейлисты"
            aria-disabled={!leftActive}
            tabIndex={leftActive ? 0 : -1}
            onPointerDown={() => onNavPointerDown(-1)}
            onClick={() => onNavClick(-1)}
          >
            <CarouselNavChevron direction="left" />
          </button>
          <button
            ref={rightBtnRef}
            type="button"
            className={`${styles.genresNavBtn} ${!rightActive ? styles.genresNavBtnInactive : ""}`}
            aria-label="Следующие плейлисты"
            aria-disabled={!rightActive}
            tabIndex={rightActive ? 0 : -1}
            onPointerDown={() => onNavPointerDown(1)}
            onClick={() => onNavClick(1)}
          >
            <CarouselNavChevron direction="right" />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className={styles.genresScroll}>
        <div className={styles.genresGrid}>
          {hasEmptyPlaylistCard ? (
            <button
              type="button"
              className={`${styles.playlistCard} ${styles.playlistCardEmpty}`}
              onClick={() => void handleCreatePlaylist()}
            >
              <span className={styles.playlistCardTitle}>Создать плейлист</span>
            </button>
          ) : (
            playlists.map(({ id, title, trackCount, variant, coverColorId }) => (
              <button
                key={id}
                type="button"
                className={`${styles.playlistCard} ${styles[variant]}`}
                style={
                  variant === "playlistCardUser" && coverColorId
                    ? ({ "--playlist-color": coverColorIdToColor(coverColorId) } as CSSProperties)
                    : undefined
                }
                onClick={() => openPlaylist(id)}
              >
                <div className={styles.playlistCardBg} />
                <span className={styles.playlistCardTitle}>{title}</span>
                <span className={`${styles.playlistCardMeta} flora-type-15`}>
                  {formatPlaylistTrackCount(trackCount)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
