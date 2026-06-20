"use client";

import { useEffect, useState } from "react";
import styles from "./gridOverlay.module.css";
import { getViewportFrame, useViewportFrameCssVars } from "./viewportFrame";

type GridCoords = {
  c15x: number;
  c15y: number;
  c5x: number;
  c5y: number;
  left: number;
  top: number;
};

const PRIMARY_STEP = 15;
const SECONDARY_STEP = 5;

/** Dev-only grid overlay + toggles; layout frame vars still sync in production (login has no DashboardShell). */
const GRID_DEBUG_ENABLED = process.env.NODE_ENV !== "production";

export function GridOverlay() {
  useViewportFrameCssVars(true);
  const [gridPrimaryEnabled, setGridPrimaryEnabled] = useState(false);
  const [gridSecondaryEnabled, setGridSecondaryEnabled] = useState(false);
  const [gridCoords, setGridCoords] = useState<GridCoords | null>(null);

  useEffect(() => {
    if (!gridPrimaryEnabled && !gridSecondaryEnabled) return;

    const handleMouseMove = (event: MouseEvent) => {
      const frame = getViewportFrame();

      if (
        event.clientX < frame.frameLeft ||
        event.clientX > frame.frameRight ||
        event.clientY < frame.frameTop ||
        event.clientY > frame.frameBottom
      ) {
        setGridCoords(null);
        return;
      }

      const x = event.clientX - frame.frameLeft;
      const y = event.clientY - frame.frameTop;
      const baseX = frame.cropOffsetX + x;
      const baseY = frame.cropOffsetY + y;

      setGridCoords({
        c15x: Math.floor(baseX / PRIMARY_STEP),
        c15y: Math.floor(baseY / PRIMARY_STEP),
        c5x: Math.floor(baseX / SECONDARY_STEP),
        c5y: Math.floor(baseY / SECONDARY_STEP),
        left: event.clientX + 12,
        top: event.clientY + 12
      });
    };

    const handleMouseLeaveWindow = () => setGridCoords(null);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseout", handleMouseLeaveWindow);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseout", handleMouseLeaveWindow);
    };
  }, [gridPrimaryEnabled, gridSecondaryEnabled]);

  if (!GRID_DEBUG_ENABLED) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className={`${styles.gridToggle} ${gridPrimaryEnabled ? styles.on : ""}`}
        onClick={() => {
          setGridPrimaryEnabled((value) => !value);
          setGridCoords(null);
        }}
        aria-pressed={gridPrimaryEnabled}
        aria-label="Toggle primary grid"
      >
        {gridPrimaryEnabled ? "GRID 15 ON" : "GRID 15 OFF"}
      </button>
      <button
        type="button"
        className={`${styles.gridToggle} ${styles.gridToggleSecondary} ${gridSecondaryEnabled ? styles.on : ""}`}
        onClick={() => {
          setGridSecondaryEnabled((value) => !value);
          setGridCoords(null);
        }}
        aria-pressed={gridSecondaryEnabled}
        aria-label="Toggle secondary grid"
      >
        {gridSecondaryEnabled ? "GRID 5 ON" : "GRID 5 OFF"}
      </button>

      {gridPrimaryEnabled || gridSecondaryEnabled ? (
        <div className={styles.gridViewport} aria-hidden>
          {gridPrimaryEnabled ? <div className={styles.gridOverlay} /> : null}
          {gridSecondaryEnabled ? <div className={styles.gridOverlayFine} /> : null}
          <div className={styles.gridCenterDot} />
        </div>
      ) : null}

      {(gridPrimaryEnabled || gridSecondaryEnabled) && gridCoords ? (
        <div className={styles.gridCoords} style={{ left: gridCoords.left, top: gridCoords.top }}>
          {gridPrimaryEnabled && gridSecondaryEnabled
            ? `15: ${gridCoords.c15x},${gridCoords.c15y} | 5: ${gridCoords.c5x},${gridCoords.c5y}`
            : gridPrimaryEnabled
              ? `15: ${gridCoords.c15x},${gridCoords.c15y}`
              : `5: ${gridCoords.c5x},${gridCoords.c5y}`}
        </div>
      ) : null}
    </>
  );
}
