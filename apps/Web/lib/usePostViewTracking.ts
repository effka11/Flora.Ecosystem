"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { apiRecordPostView, primeDevPostViewCount } from "@/lib/socialApi";

const SESSION_STORAGE_KEY = "flora.postViews.session";

type PostViewSource = {
  postUuid: string;
  viewsCount: number;
};

type UsePostViewTrackingOptions = {
  scrollRootRef?: RefObject<Element | null>;
  onViewsCountChange?: (postUuid: string, viewsCount: number) => void;
};

function readSessionRecorded(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((value): value is string => typeof value === "string"));
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

function writeSessionRecorded(ids: Set<string>): void {
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

function findScrollRoot(el: HTMLElement): Element | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const { overflowY } = window.getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export function usePostViewTracking(options: UsePostViewTrackingOptions = {}) {
  const { scrollRootRef } = options;
  const onChangeRef = useRef(options.onViewsCountChange);
  onChangeRef.current = options.onViewsCountChange;

  const recordedRef = useRef<Set<string> | null>(null);
  if (recordedRef.current === null) {
    recordedRef.current = readSessionRecorded();
  }

  const observersRef = useRef(new Map<string, IntersectionObserver>());
  const refCallbacksRef = useRef(new Map<string, (el: HTMLLIElement | null) => void>());
  const initialCountsRef = useRef(new Map<string, number>());
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({});

  const recordView = useCallback((postUuid: string, initialViewsCount: number) => {
    const recorded = recordedRef.current;
    if (!recorded || recorded.has(postUuid)) return;

    recorded.add(postUuid);
    writeSessionRecorded(recorded);

    primeDevPostViewCount(postUuid, initialViewsCount);
    void apiRecordPostView(postUuid, initialViewsCount)
      .then((result) => {
        setViewCounts((prev) => ({ ...prev, [postUuid]: result.viewsCount }));
        onChangeRef.current?.(postUuid, result.viewsCount);
      })
      .catch(() => {
        recorded.delete(postUuid);
        writeSessionRecorded(recorded);
      });
  }, []);

  const getPostItemRef = useCallback(
    (postUuid: string, initialViewsCount: number) => {
      initialCountsRef.current.set(postUuid, initialViewsCount);

      let cb = refCallbacksRef.current.get(postUuid);
      if (!cb) {
        cb = (el: HTMLLIElement | null) => {
          const prev = observersRef.current.get(postUuid);
          if (prev) {
            prev.disconnect();
            observersRef.current.delete(postUuid);
          }
          if (!el) return;

          const recorded = recordedRef.current;
          if (recorded?.has(postUuid)) return;

          const root = scrollRootRef?.current ?? findScrollRoot(el);
          const observer = new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (!entry.isIntersecting || entry.intersectionRatio < 0.4) continue;
                observer.disconnect();
                observersRef.current.delete(postUuid);
                const initial = initialCountsRef.current.get(postUuid) ?? initialViewsCount;
                recordView(postUuid, initial);
                break;
              }
            },
            { root, threshold: [0, 0.25, 0.4, 0.5, 0.75, 1] },
          );
          observer.observe(el);
          observersRef.current.set(postUuid, observer);
        };
        refCallbacksRef.current.set(postUuid, cb);
      }

      return cb;
    },
    [recordView, scrollRootRef],
  );

  const viewsCountFor = useCallback(
    (post: PostViewSource) => viewCounts[post.postUuid] ?? post.viewsCount,
    [viewCounts],
  );

  useEffect(() => {
    const observers = observersRef.current;
    return () => {
      for (const observer of observers.values()) observer.disconnect();
      observers.clear();
    };
  }, []);

  return { viewsCountFor, getPostItemRef };
}
