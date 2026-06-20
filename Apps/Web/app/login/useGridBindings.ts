"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DependencyList, Dispatch, RefObject, SetStateAction } from "react";
import { getViewportFrame, snapToGrid } from "@/app/_shared/viewportFrame";

export type SnapMode = "none" | "grid15" | "grid5";

export type GridCoords = {
  c15x: number;
  c15y: number;
  c5x: number;
  c5y: number;
  left: number;
  top: number;
};

type Offset = { x: number; y: number };

type UseGridBindingsOptions<T extends string> = {
  gridEnabled: boolean;
  refs: Record<T, RefObject<HTMLElement>>;
  panelTarget: T;
  initialBinding?: Partial<Record<T, SnapMode>>;
  stepPrimary?: number;
  stepSecondary?: number;
  effectDeps?: DependencyList;
};

export function useGridBindings<T extends string>({
  gridEnabled,
  refs,
  panelTarget,
  initialBinding,
  stepPrimary = 15,
  stepSecondary = 5,
  effectDeps = []
}: UseGridBindingsOptions<T>) {
  const targets = useMemo(() => Object.keys(refs) as T[], [refs]);

  const [gridCoords, setGridCoords] = useState<GridCoords | null>(null);
  const [gridBinding] = useState<Record<T, SnapMode>>(() =>
    targets.reduce(
      (acc, key) => ({
        ...acc,
        [key]: initialBinding?.[key] ?? "none"
      }),
      {} as Record<T, SnapMode>
    )
  );
  const [panelSnapPosition, setPanelSnapPosition] = useState<{ left: number; top: number } | null>(null);
  const [offsets, setOffsets] = useState<Record<T, Offset | null>>(() =>
    targets.reduce((acc, key) => ({ ...acc, [key]: null }), {} as Record<T, Offset | null>)
  );

  const getStep = useCallback(
    (mode: SnapMode) => (mode === "grid5" ? stepSecondary : stepPrimary),
    [stepPrimary, stepSecondary]
  );

  const clearGridCoords = useCallback(() => setGridCoords(null), []);

  const handleGridMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!gridEnabled) {
        return;
      }

      const frame = getViewportFrame();

      if (
        e.clientX < frame.frameLeft ||
        e.clientX > frame.frameRight ||
        e.clientY < frame.frameTop ||
        e.clientY > frame.frameBottom
      ) {
        setGridCoords(null);
        return;
      }

      const x = e.clientX - frame.frameLeft;
      const y = e.clientY - frame.frameTop;
      const baseX = frame.cropOffsetX + x;
      const baseY = frame.cropOffsetY + y;

      setGridCoords({
        c15x: Math.floor(baseX / stepPrimary),
        c15y: Math.floor(baseY / stepPrimary),
        c5x: Math.floor(baseX / stepSecondary),
        c5y: Math.floor(baseY / stepSecondary),
        left: e.clientX + 12,
        top: e.clientY + 12
      });
    },
    [gridEnabled, stepPrimary, stepSecondary]
  );

  const recomputeBindings = useCallback(() => {
    const frame = getViewportFrame();

    const panelRef = refs[panelTarget];
    if (gridBinding[panelTarget] === "none" || !panelRef.current) {
      setPanelSnapPosition(null);
    } else {
      const panelWidth = panelRef.current.offsetWidth;
      const panelHeight = panelRef.current.offsetHeight;
      const preferredLeft = frame.frameLeft + (frame.frameWidth - panelWidth) / 2;
      const preferredTop = frame.frameTop + (frame.frameHeight - panelHeight) / 2;
      const step = getStep(gridBinding[panelTarget]);
      const snappedLeft = snapToGrid(preferredLeft, frame.frameLeft, step);
      const snappedTop = snapToGrid(preferredTop, frame.frameTop, step);
      setPanelSnapPosition({ left: snappedLeft, top: snappedTop });
    }

    const applyOffsetFor = (target: T, setter: Dispatch<SetStateAction<Record<T, Offset | null>>>) => {
      if (target === panelTarget) {
        return;
      }

      const ref = refs[target];
      const mode = gridBinding[target];
      if (!ref.current || mode === "none") {
        setter((prev) => ({ ...prev, [target]: null }));
        return;
      }

      const rect = ref.current.getBoundingClientRect();
      const step = getStep(mode);
      const snappedLeft = snapToGrid(rect.left, frame.frameLeft, step);
      const snappedTop = snapToGrid(rect.top, frame.frameTop, step);
      setter((prev) => ({
        ...prev,
        [target]: {
          x: Math.round(snappedLeft - rect.left),
          y: Math.round(snappedTop - rect.top)
        }
      }));
    };

    requestAnimationFrame(() => {
      targets.forEach((target) => applyOffsetFor(target, setOffsets));
    });
  }, [refs, panelTarget, gridBinding, getStep, targets]);

  useEffect(() => {
    recomputeBindings();
    window.addEventListener("resize", recomputeBindings);
    return () => window.removeEventListener("resize", recomputeBindings);
  }, [recomputeBindings, ...effectDeps]);

  return {
    gridCoords,
    handleGridMove,
    clearGridCoords,
    gridBinding,
    panelSnapPosition,
    offsets
  };
}

