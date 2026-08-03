import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { ChromeMoreIcon } from "@/components/chrome/ChromeIcons";
import { floraFeedPost } from "@/lib/theme";

type IconProps = {
  size?: number;
  color: string;
  filled?: boolean;
};

/** Path’и как в Apps/Web FeedPostList / feed page; stroke тоньше web (2 → 1.5). */
const STROKE = 1.5;

const HEART =
  "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z";

const COMMENT = "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z";

const REPOST_A = "M17 1l4 4-4 4";
const REPOST_B = "M3 11V9a4 4 0 0 1 4-4h14";
const REPOST_C = "M7 23l-4-4 4-4";
const REPOST_D = "M21 13v2a4 4 0 0 1-4 4H3";

const VIEWS_EYE = "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z";

const glyphSlot = StyleSheet.create({
  slot: {
    width: floraFeedPost.moreGlyphSlot,
    height: floraFeedPost.moreGlyphSlot,
    alignItems: "center",
    justifyContent: "center",
  },
});

export function FeedPostHeartIcon({ size = 18, color, filled = false }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      <Path d={HEART} fill={filled ? color : "none"} stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

export function FeedPostCommentIcon({ size = 18, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      <Path d={COMMENT} fill="none" stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

export function FeedPostRepostIcon({ size = 18, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      <Path d={REPOST_A} fill="none" stroke={color} strokeWidth={STROKE} />
      <Path d={REPOST_B} fill="none" stroke={color} strokeWidth={STROKE} />
      <Path d={REPOST_C} fill="none" stroke={color} strokeWidth={STROKE} />
      <Path d={REPOST_D} fill="none" stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

export function FeedPostViewsIcon({ size = 16, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      <Path d={VIEWS_EYE} fill="none" stroke={color} strokeWidth={STROKE} />
      <Circle cx={12} cy={12} r={3} fill="none" stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

export function FeedPostMoreIcon({ size = floraFeedPost.moreGlyphSize, color }: IconProps) {
  return (
    <View style={glyphSlot.slot}>
      <ChromeMoreIcon size={size} color={color} />
    </View>
  );
}

export function FeedPostCloseIcon({ size = floraFeedPost.moreCloseGlyphSize, color }: IconProps) {
  return (
    <View style={glyphSlot.slot}>
      <Ionicons name="close-outline" size={size} color={color} style={{ includeFontPadding: false }} />
    </View>
  );
}
