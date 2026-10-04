import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import styles from "../app/(dashboard)/feed/feed.module.css";
import {
  FEED_COMPACT_LEVEL_PX,
  FEED_EXPANDED_HEADER_PX,
  useFeedCompactHeader,
  type FeedCompactHeaderClassMap,
} from "../app/(dashboard)/feed/useFeedCompactHeader";

const classMap: FeedCompactHeaderClassMap = {
  base: styles.feedTopBlock,
  compact: styles.feedTopBlockCompact,
  compactAnimate: styles.feedTopBlockCompactAnimate,
  noTransition: styles.feedTopBlockNoTransition,
  leaving: styles.feedTopBlockLeavingCompact,
};

declare global {
  interface Window {
    __feedCompactHarness?: {
      scrollTop: () => number;
      threshold: () => number;
      hasCompactClass: () => boolean;
      isCompactState: () => boolean;
      headerHeight: () => number;
      headerPosition: () => string;
    };
  }
}

function FeedCompactScrollHarness() {
  const scrollRef = useRef<HTMLElement | null>(null);
  const topBlockRef = useRef<HTMLDivElement | null>(null);
  const { isCompact } = useFeedCompactHeader(scrollRef, topBlockRef, classMap);

  useEffect(() => {
    window.__feedCompactHarness = {
      scrollTop: () => scrollRef.current?.scrollTop ?? 0,
      threshold: () => Math.max(0, FEED_EXPANDED_HEADER_PX - FEED_COMPACT_LEVEL_PX),
      hasCompactClass: () => {
        const block = topBlockRef.current;
        if (!block || !classMap.compact) return false;
        return block.classList.contains(classMap.compact);
      },
      isCompactState: () => isCompact,
      headerHeight: () => topBlockRef.current?.offsetHeight ?? 0,
      headerPosition: () => {
        const block = topBlockRef.current;
        if (!block) return "";
        return getComputedStyle(block).position;
      },
    };
  }, [isCompact]);

  return (
    <section
      ref={scrollRef}
      id="central-scroll-feed"
      className={styles.feedPage}
      data-testid="feed-scroll"
      style={{ height: "100%" }}
    >
      <div ref={topBlockRef} data-testid="feed-top-block">
        <div className={styles.feedTopBlockInner}>
          <div style={{ padding: 12, color: "#fff" }}>Feed header harness</div>
        </div>
      </div>
      <div data-testid="feed-body" style={{ flex: "0 0 auto", minHeight: 3200, background: "#111" }}>
        <div style={{ padding: 16, color: "#ccc" }}>Tall feed body for wheel scroll</div>
      </div>
    </section>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing #root");
}
createRoot(rootEl).render(<FeedCompactScrollHarness />);
