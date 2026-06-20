"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  MUSIC_ROUTE_TRANSITION_CLEAR_MS,
  resolveMusicRoutePanelTransition,
  shouldAnimateMusicRoute,
  type MusicRoutePanelTransition,
} from "@/app/(dashboard)/music/musicRouteTransition";
import styles from "./music.module.css";

export default function MusicLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const prevPathRef = useRef(pathname);
  const clearRef = useRef<number | null>(null);
  const [panelTransition, setPanelTransition] = useState<MusicRoutePanelTransition>(null);
  const [panelAnimEpoch, setPanelAnimEpoch] = useState(0);

  useEffect(() => {
    const from = prevPathRef.current;
    const to = pathname;
    if (from === to) return;

    if (clearRef.current !== null) {
      window.clearTimeout(clearRef.current);
      clearRef.current = null;
    }

    const nextTransition = shouldAnimateMusicRoute(from, to)
      ? resolveMusicRoutePanelTransition(from, to)
      : null;

    if (nextTransition) {
      setPanelAnimEpoch((epoch) => epoch + 1);
      setPanelTransition(nextTransition);
      clearRef.current = window.setTimeout(() => {
        setPanelTransition(null);
        clearRef.current = null;
      }, MUSIC_ROUTE_TRANSITION_CLEAR_MS);
    } else {
      setPanelTransition(null);
    }

    prevPathRef.current = to;
  }, [pathname]);

  useEffect(
    () => () => {
      if (clearRef.current !== null) window.clearTimeout(clearRef.current);
    },
    [],
  );

  const panelClassName = panelTransition ? styles.musicRoutePanelInnerIn : "";

  return (
    <div className={styles.musicRoutePanel}>
      <div key={panelAnimEpoch} className={`${styles.musicRoutePanelInner} ${panelClassName}`}>
        {children}
      </div>
    </div>
  );
}
