import Svg, { Circle, Path } from "react-native-svg";

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
 */
export function ChatHeaderBackIcon({ size = 24, color }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
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
 * Вертикальное ⋮: крупнее шрифтового 16–18, точки тоньше ionicons glyph.
 */
export function ChatHeaderMoreIcon({ size = 24, color }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      <Circle cx={12} cy={6.5} r={DOT_R} fill={color} />
      <Circle cx={12} cy={12} r={DOT_R} fill={color} />
      <Circle cx={12} cy={17.5} r={DOT_R} fill={color} />
    </Svg>
  );
}
