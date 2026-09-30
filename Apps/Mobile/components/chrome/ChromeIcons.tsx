import Svg, { Circle, Path } from "react-native-svg";
import { useSPx } from "@/lib/FloraGridProvider";

type Props = {
  size?: number;
  color: string;
};

/** Как stroke у Ionicons `search-outline` (лупа) — тонкая линия на комфортном размере. */
const STROKE = 1.5;
/** Радиус точек ⋮ в viewBox 24 — тоньше шрифтового ellipsis-vertical. */
const DOT_R = 1.35;

/**
 * Стрелка назад: размер как у лупы/«+», толщина stroke как у search-outline.
 * Общий chrome (Messages / Feed) — не домен messages.
 */
export function ChromeBackIcon({ size, color }: Props) {
  const sp = useSPx();
  const px = size ?? sp(24);
  return (
    <Svg width={px} height={px} viewBox="0 0 24 24" accessibilityElementsHidden>
      <Path
        d="M15 18l-6-6 6-6"
        fill="none"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Вертикальное ⋮: тонкие точки, слот 24. Общий chrome (Messages / Feed).
 */
export function ChromeMoreIcon({ size, color }: Props) {
  const sp = useSPx();
  const px = size ?? sp(24);
  return (
    <Svg width={px} height={px} viewBox="0 0 24 24" accessibilityElementsHidden>
      <Circle cx={12} cy={6.5} r={DOT_R} fill={color} />
      <Circle cx={12} cy={12} r={DOT_R} fill={color} />
      <Circle cx={12} cy={17.5} r={DOT_R} fill={color} />
    </Svg>
  );
}

/**
 * Сохранённый поиск: галочка, уже зеркальная по X.
 * Правый штрих чуть длиннее стандартного stem, с зазором до лупы.
 */
export function ChromeSearchSavedCheck({ size, color }: Props) {
  const sp = useSPx();
  const px = size ?? sp(13);
  return (
    <Svg width={px} height={px} viewBox="0 0 24 24" accessibilityElementsHidden>
      <Path
        d="M14 18L4 6"
        fill="none"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M14 18L20.5 11.5"
        fill="none"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
