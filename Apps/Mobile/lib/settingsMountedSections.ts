/**
 * Sticky mount-window for Settings pager sections.
 * Expand neighbors only after settle/wake — never mid-pan.
 */

/** Clamp horizontal chip-strip offset into [0, maxStripOffset]. */
export function clampStripOffset(offset: number, maxStripOffset: number): number {
  const max = Math.max(0, maxStripOffset);
  if (offset < 0) return 0;
  if (offset > max) return max;
  return offset;
}

export function expandMountedAround<T extends string>(
  sectionIds: readonly T[],
  index: number,
): ReadonlySet<T> {
  const next = new Set<T>();
  if (sectionIds.length === 0) return next;
  const clamped = Math.max(0, Math.min(index, sectionIds.length - 1));
  const from = Math.max(0, clamped - 1);
  const to = Math.min(sectionIds.length - 1, clamped + 1);
  for (let i = from; i <= to; i++) {
    next.add(sectionIds[i]!);
  }
  return next;
}

export function reconcileMountedIds<T extends string>(options: {
  prev: ReadonlySet<T>;
  visibleIds: readonly T[];
  activeIndex: number;
  expandNeighbors: boolean;
}): ReadonlySet<T> {
  const { prev, visibleIds, activeIndex, expandNeighbors } = options;
  const visibleSet = new Set(visibleIds);
  const next = new Set<T>();

  for (const id of prev) {
    if (visibleSet.has(id)) next.add(id);
  }

  if (visibleIds.length === 0) return next;

  const clamped = Math.max(0, Math.min(activeIndex, visibleIds.length - 1));
  next.add(visibleIds[clamped]!);

  if (expandNeighbors) {
    for (const id of expandMountedAround(visibleIds, clamped)) {
      next.add(id);
    }
  }

  return next;
}

export function mountedSetsEqual<T extends string>(
  a: ReadonlySet<T>,
  b: ReadonlySet<T>,
): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/**
 * Следующая секция для idle-прогрева: ближайшая немонтированная к активной,
 * при равном расстоянии — вперёд (направление листания). После прогрева всех
 * видимых секций свайп не вызывает mount вообще.
 */
export function nextMountCandidate<T extends string>(
  visibleIds: readonly T[],
  mounted: ReadonlySet<T>,
  activeIndex: number,
): T | null {
  if (visibleIds.length === 0) return null;
  const clamped = Math.max(0, Math.min(activeIndex, visibleIds.length - 1));
  if (!mounted.has(visibleIds[clamped]!)) return visibleIds[clamped]!;
  for (let distance = 1; distance < visibleIds.length; distance++) {
    const forward = clamped + distance;
    if (forward < visibleIds.length && !mounted.has(visibleIds[forward]!)) {
      return visibleIds[forward]!;
    }
    const backward = clamped - distance;
    if (backward >= 0 && !mounted.has(visibleIds[backward]!)) {
      return visibleIds[backward]!;
    }
  }
  return null;
}
