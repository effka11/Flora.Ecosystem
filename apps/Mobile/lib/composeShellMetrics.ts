/**
 * Метрики compose-оболочки для дока и зазора ленты.
 *
 * `height` — полная высота оболочки (полоса вложений + поле + нижний отступ),
 * `mediaHeight` — высота полосы вложений, `baseHeight` — высота оболочки на
 * одной строке без полосы. Док калибрует baseline только по `baseHeight`:
 * выводить его из общей высоты нельзя — тогда разовая полоса фото впитывается
 * в постоянный зазор, и после снятия полосы лента стоит на завышенном отступе.
 */
export type ComposeShellMetrics = {
  height: number;
  /** `null` — полосы вложений нет. */
  mediaHeight: number | null;
  /** `null` — полоса есть, но её высота ещё не измерена. */
  baseHeight: number | null;
};

export function composeShellMetrics(args: {
  height: number;
  /** Число видимых строк текста (>= 1). */
  rows: number;
  mediaPresent: boolean;
  /** Измеренная высота полосы; 0 — ещё не измерена. */
  mediaHeight: number;
  lineHeight: number;
}): ComposeShellMetrics {
  const height = args.height;
  if (height <= 0) {
    return { height: 0, mediaHeight: args.mediaPresent ? args.mediaHeight : null, baseHeight: null };
  }
  const rows = Math.max(args.rows, 1);
  const rowExtra = (rows - 1) * args.lineHeight;
  if (!args.mediaPresent) {
    return {
      height,
      mediaHeight: null,
      baseHeight: singleLineBase(height - rowExtra),
    };
  }
  const mediaHeight = Math.max(args.mediaHeight, 0);
  return {
    height,
    mediaHeight,
    // Полоса есть, но не измерена: height - 0 увёл бы её высоту в baseline.
    baseHeight: mediaHeight > 0 ? singleLineBase(height - mediaHeight - rowExtra) : null,
  };
}

function singleLineBase(height: number): number | null {
  return height > 0 ? height : null;
}
