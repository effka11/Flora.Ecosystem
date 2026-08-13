/**
 * Счётчики поста: целые тысячи/миллионы без дроби — 3921 → «3к», 12847 → «12к».
 */
export function formatCompactCount(value: number): string {
  const n = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.floor(n / 1000)}к`;
  return `${Math.floor(n / 1_000_000)}м`;
}
