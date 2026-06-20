import { useEffect, useRef, useState, type RefObject } from "react";

/** Высота компактной шапки (5 рядов первичной сетки), как --g75 в референсе. */
export const FEED_COMPACT_LEVEL_PX = 75;

const MIN_HEIGHT_CLEAR_MS = 450;
const COMPACT_ANIMATE_DELAY_MS = 50;
const LEAVE_EXPAND_ANIM_MS = 420;

export type FeedCompactHeaderState = {
  isCompact: boolean;
  compactAnimate: boolean;
  noTransition: boolean;
  /** Один кадр с compact=false: enter-анимации выхода (как feed-tabs-expanding в 2142-1). */
  isLeavingCompact: boolean;
};

/**
 * Порог и sticky/minHeight — как FloraScrollLoad.observeScrollForCompact в 2142-1.
 * Класс компакта на блоке — через React state; геометрия sticky — через inline style на DOM.
 */
export function useFeedCompactHeader(
  scrollRef: RefObject<HTMLElement | null>,
  topBlockRef: RefObject<HTMLElement | null>
): FeedCompactHeaderState {
  const [isCompact, setIsCompact] = useState(false);
  const [compactAnimate, setCompactAnimate] = useState(false);
  const [noTransition, setNoTransition] = useState(false);
  const [isLeavingCompact, setIsLeavingCompact] = useState(false);

  const lastCompactRef = useRef<boolean | null>(null);
  const isCompactRef = useRef(false);
  const minHeightClearRef = useRef<number | null>(null);
  const compactAnimateRef = useRef<number | null>(null);
  const leaveExpandClearRef = useRef<number | null>(null);

  isCompactRef.current = isCompact;

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    let ticking = false;

    const clearTimers = () => {
      if (minHeightClearRef.current !== null) {
        window.clearTimeout(minHeightClearRef.current);
        minHeightClearRef.current = null;
      }
      if (compactAnimateRef.current !== null) {
        window.clearTimeout(compactAnimateRef.current);
        compactAnimateRef.current = null;
      }
      if (leaveExpandClearRef.current !== null) {
        window.clearTimeout(leaveExpandClearRef.current);
        leaveExpandClearRef.current = null;
      }
    };

    const enterCompact = (block: HTMLElement, blockHeight: number) => {
      clearTimers();
      setIsLeavingCompact(false);
      block.style.minHeight = `${blockHeight}px`;
      block.style.setProperty("--compact-stick-top", `${FEED_COMPACT_LEVEL_PX - blockHeight}px`);
      setNoTransition(false);
      setIsCompact(true);
      setCompactAnimate(false);
      compactAnimateRef.current = window.setTimeout(() => {
        setCompactAnimate(true);
        compactAnimateRef.current = null;
      }, COMPACT_ANIMATE_DELAY_MS);
    };

    const leaveCompact = (block: HTMLElement) => {
      clearTimers();
      /* Всё в одном батче: без кадра «развёрнуто, но ещё без анимации». */
      setNoTransition(true);
      setIsCompact(false);
      setCompactAnimate(false);
      setIsLeavingCompact(true);
      block.style.removeProperty("--compact-stick-top");
      /* Как scroll-load.js в 2142: no-transition до снятия minHeight (~450ms), иначе layout-transition бьётся с keyframes. */
      leaveExpandClearRef.current = window.setTimeout(() => {
        setIsLeavingCompact(false);
        leaveExpandClearRef.current = null;
      }, LEAVE_EXPAND_ANIM_MS);
      minHeightClearRef.current = window.setTimeout(() => {
        if (!isCompactRef.current) {
          block.style.minHeight = "";
          setNoTransition(false);
        }
        minHeightClearRef.current = null;
      }, MIN_HEIGHT_CLEAR_MS);
    };

    const update = () => {
      const block = topBlockRef.current;
      const blockHeight = block?.offsetHeight ?? 0;
      const scrollTop = root.scrollTop;
      const threshold = Math.max(0, blockHeight - FEED_COMPACT_LEVEL_PX);
      const compact = scrollTop > threshold;

      if (lastCompactRef.current !== compact) {
        if (block) {
          if (compact) {
            enterCompact(block, blockHeight);
          } else if (lastCompactRef.current === true) {
            leaveCompact(block);
          }
        } else {
          setIsCompact(compact);
          setCompactAnimate(false);
          setIsLeavingCompact(false);
        }
        lastCompactRef.current = compact;
      }
      ticking = false;
    };

    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    };

    root.addEventListener("scroll", onScroll, { passive: true });
    update();

    return () => {
      root.removeEventListener("scroll", onScroll);
      clearTimers();
    };
  }, [scrollRef, topBlockRef]);

  return { isCompact, compactAnimate, noTransition, isLeavingCompact };
}
