import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";

type IconProps = {
  size?: number;
  color: ColorValue;
};

function fillColor(color: ColorValue): string {
  return typeof color === "string" ? color : String(color);
}

/**
 * Иконки нижнего tab bar — path’и как в Apps/Web DashboardShell / MusicNavIcon.
 * Лента / сообщения / уведомления: viewBox 24; музыка: 512 (как web).
 */

const FEED_HOME = "M12 2L2 10v12h7v-6h6v6h7V10L12 2z";

const MESSAGES =
  "M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3l2.5 4.5 2.5-4.5H19a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z";

const NOTIFICATIONS =
  "M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z";

/** Профиль: Material person (filled), в том же стиле fill currentColor, что и web-nav. */
const PROFILE =
  "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z";

/** Как MusicNavIcon.tsx на вебе. */
const MUSIC =
  "M 429.5,-0.5 C 433.5,-0.5 437.5,-0.5 441.5,-0.5C 445.479,1.31481 448.312,4.31481 450,8.5C 450.667,125.167 450.667,241.833 450,358.5C 445.141,385.385 430.307,404.552 405.5,416C 370.58,428.312 340.746,420.812 316,393.5C 299.166,369.676 295.833,344.01 306,316.5C 325.33,279.588 355.497,265.421 396.5,274C 404.672,276.669 412.172,280.502 419,285.5C 419.833,232.83 419.667,180.164 418.5,127.5C 349.539,153.765 280.539,179.932 211.5,206C 210.988,288.466 210.154,370.966 209,453.5C 199.92,485.083 179.42,504.417 147.5,511.5C 139.5,511.5 131.5,511.5 123.5,511.5C 92.018,504.523 71.518,485.523 62,454.5C 55.3383,414.657 69.8383,385.49 105.5,367C 131.726,357.28 156.392,360.113 179.5,375.5C 180.005,282.421 180.838,189.421 182,96.5C 183.765,93.527 186.265,91.3604 189.5,90C 269.715,60.0993 349.715,29.9326 429.5,-0.5 Z";

export function TabBarFeedIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fillColor(color)} accessibilityElementsHidden>
      <Path d={FEED_HOME} />
    </Svg>
  );
}

export function TabBarMessagesIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fillColor(color)} accessibilityElementsHidden>
      <Path d={MESSAGES} />
    </Svg>
  );
}

export function TabBarMusicIcon({ size = 24, color }: IconProps) {
  const draw = Math.round(size * 0.9);
  return (
    <Svg width={draw} height={draw} viewBox="0 0 512 512" fill={fillColor(color)} accessibilityElementsHidden>
      <Path d={MUSIC} fillRule="evenodd" clipRule="evenodd" />
    </Svg>
  );
}

export function TabBarNotificationsIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fillColor(color)} accessibilityElementsHidden>
      <Path d={NOTIFICATIONS} />
    </Svg>
  );
}

export function TabBarProfileIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fillColor(color)} accessibilityElementsHidden>
      <Path d={PROFILE} />
    </Svg>
  );
}
