/** Как SWIPE_OPEN_VX у drawer — порог флика (px/s). */
export const ENERGETIC_SNAP_VX = 220;

/**
 * Snap горизонтального pager-offset после pan.
 * `fingerVelocityX` — velocity из RNGH (палец вправо > 0); offset растёт при свайпе влево.
 * Без флика — nearest page (двусторонние вкладки); порог флика как SWIPE_OPEN_VX у drawer.
 */
export function snapPagerOffset(
  offsetX: number,
  pageWidth: number,
  pageCount: number,
  fingerVelocityX: number,
): number {
  "worklet";
  if (pageWidth <= 0 || pageCount <= 0) return 0;
  const maxIndex = pageCount - 1;
  const page = offsetX / pageWidth;
  const scrollVelocity = -fingerVelocityX;
  let index: number;
  if (scrollVelocity > ENERGETIC_SNAP_VX) {
    index = Math.ceil(page - 1e-3);
  } else if (scrollVelocity < -ENERGETIC_SNAP_VX) {
    index = Math.floor(page + 1e-3);
  } else {
    index = Math.round(page);
  }
  index = Math.max(0, Math.min(maxIndex, index));
  return index * pageWidth;
}
