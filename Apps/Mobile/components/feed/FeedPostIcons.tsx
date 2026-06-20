import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, View, type StyleProp, type TextStyle } from "react-native";
import { floraFeedPost } from "@/lib/theme";

type IconProps = {
  size?: number;
  color: string;
  filled?: boolean;
};

const thin: StyleProp<TextStyle> = { includeFontPadding: false };

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
    <Ionicons
      name={filled ? "heart" : "heart-outline"}
      size={size}
      color={color}
      style={thin}
    />
  );
}

export function FeedPostCommentIcon({ size = 18, color }: IconProps) {
  return <Ionicons name="chatbubble-outline" size={size} color={color} style={thin} />;
}

export function FeedPostRepostIcon({ size = 18, color }: IconProps) {
  return <Ionicons name="repeat-outline" size={size} color={color} style={thin} />;
}

export function FeedPostViewsIcon({ size = 16, color }: IconProps) {
  return <Ionicons name="eye-outline" size={size} color={color} style={thin} />;
}

export function FeedPostMoreIcon({ size = floraFeedPost.moreGlyphSize, color }: IconProps) {
  return (
    <View style={glyphSlot.slot}>
      <Ionicons name="ellipsis-vertical" size={size} color={color} style={thin} />
    </View>
  );
}

export function FeedPostCloseIcon({ size = floraFeedPost.moreCloseGlyphSize, color }: IconProps) {
  return (
    <View style={glyphSlot.slot}>
      <Ionicons name="close" size={size} color={color} style={thin} />
    </View>
  );
}
