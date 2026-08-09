import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Высота компактной шапки (5 рядов первичной сетки), как --g75 в референсе. */
export const FEED_COMPACT_LEVEL_PX = 75;

/**
 * Гистерезис у порога (1× primary grid): без него trackpad/wheel вокруг
 * `blockHeight - 75` гоняет compact↔normal и sticky «залипает».
 */
export const FEED_COMPACT_HYSTERESIS_PX = 15;

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

/** CSS-module классы top-block — хук владеет classList (base + sticky/leave) в scroll-rAF. */
export type FeedCompactHeaderClassMap = {
  /** Базовый класс блока; всегда на узле до toggle compact. */
  base: string;
  compact: string;
  compactAnimate: string;
  noTransition: string;
  leaving: string;
};

/**
 * Нужен ли компакт при текущем scrollTop.
 * Вход: строго выше порога; выход: только после гистерезиса вверх — иначе дребезг у границы.
 */
export function shouldFeedHeaderBeCompact(
  scrollTop: number,
  threshold: number,
  wasCompact: boolean,
  hysteresisPx: number = FEED_COMPACT_HYSTERESIS_PX
): boolean {
  if (wasCompact) {
    return scrollTop > Math.max(0, threshold - hysteresisPx);
  }
  return scrollTop > threshold;
}

function syncCompactDomClasses(
  block: HTMLElement,
  classMap: FeedCompactHeaderClassMap,
  next: {
    compact: boolean;
    compactAnimate: boolean;
    noTransition: boolean;
    leaving: boolean;
  }
) {
  block.classList.add(classMap.base);
  block.classList.toggle(classMap.compact, next.compact);
  block.classList.toggle(classMap.compactAnimate, next.compactAnimate);
  block.classList.toggle(classMap.noTransition, next.noTransition);
  block.classList.toggle(classMap.leaving, next.leaving);
}

/**
 * Порог и sticky/minHeight — как FloraScrollLoad.observeScrollForCompact в 2142-1.
 * Геометрия и sticky-классы — императивно в scroll-rAF (без flushSync), чтобы Chromium
 * не рвал wheel-жест sync React-коммитом. React state — только для вторичного UI.
 * Harness (`feed:compact-scroll-repro`) is a continuity regression gate; Playwright
 * wheel did not reproduce the prod freeze on the old flushSync path — see script header.
 */
export function useFeedCompactHeader(
  scrollRef: RefObject<HTMLElement | null>,
  topBlockRef: RefObject<HTMLElement | null>,
  classMap: FeedCompactHeaderClassMap
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
  const classMapRef = useRef(classMap);
  classMapRef.current = classMap;

  isCompactRef.current = isCompact;

  /* useLayoutEffect: base class до paint; иначе первый кадр без .feedTopBlock. */
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    const blockOnMount = topBlockRef.current;
    if (blockOnMount) {
      syncCompactDomClasses(blockOnMount, classMapRef.current, {
        compact: false,
        compactAnimate: false,
        noTransition: false,
        leaving: false,
      });
    }

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
      const map = classMapRef.current;
      /* Сначала геометрия + classList — как 2142 до paint; React state без flushSync. */
      block.style.minHeight = `${blockHeight}px`;
      block.style.setProperty("--compact-stick-top", `${FEED_COMPACT_LEVEL_PX - blockHeight}px`);
      syncCompactDomClasses(block, map, {
        compact: true,
        compactAnimate: false,
        noTransition: false,
        leaving: false,
      });
      setIsLeavingCompact(false);
      setNoTransition(false);
      setIsCompact(true);
      setCompactAnimate(false);
      compactAnimateRef.current = window.setTimeout(() => {
        const b = topBlockRef.current;
        if (b) {
          syncCompactDomClasses(b, classMapRef.current, {
            compact: true,
            compactAnimate: true,
            noTransition: false,
            leaving: false,
          });
        }
        setCompactAnimate(true);
        compactAnimateRef.current = null;
      }, COMPACT_ANIMATE_DELAY_MS);
    };

    const leaveCompact = (block: HTMLElement) => {
      clearTimers();
      const map = classMapRef.current;
      block.style.removeProperty("--compact-stick-top");
      syncCompactDomClasses(block, map, {
        compact: false,
        compactAnimate: false,
        noTransition: true,
        leaving: true,
      });
      setNoTransition(true);
      setIsCompact(false);
      setCompactAnimate(false);
      setIsLeavingCompact(true);
      /* Как scroll-load.js в 2142: no-transition до снятия minHeight (~450ms). */
      leaveExpandClearRef.current = window.setTimeout(() => {
        const b = topBlockRef.current;
        if (b && !isCompactRef.current) {
          syncCompactDomClasses(b, classMapRef.current, {
            compact: false,
            compactAnimate: false,
            noTransition: true,
            leaving: false,
          });
        }
        setIsLeavingCompact(false);
        leaveExpandClearRef.current = null;
      }, LEAVE_EXPAND_ANIM_MS);
      minHeightClearRef.current = window.setTimeout(() => {
        if (!isCompactRef.current) {
          block.style.minHeight = "";
          syncCompactDomClasses(block, classMapRef.current, {
            compact: false,
            compactAnimate: false,
            noTransition: false,
            leaving: false,
          });
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
      const wasCompact = lastCompactRef.current === true;
      const compact = shouldFeedHeaderBeCompact(scrollTop, threshold, wasCompact);

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
