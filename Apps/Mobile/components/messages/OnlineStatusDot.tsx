import { useEffect, useRef } from "react";
import {
  AccessibilityInfo,
  Animated,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { floraColors } from "@/lib/theme";

const FADE_MS = 220;

type Props = {
  online: boolean;
  /**
   * Peer / row identity. When it changes (FlashList recycle or chat switch),
   * animated values snap to the new `online` without cross-fading the previous peer.
   */
  identityKey?: string;
  /** Override size/position; defaults match chat list (10×10). */
  style?: StyleProp<ViewStyle>;
};

/** Online status dot with opacity + scale fade (native driver). */
export function OnlineStatusDot({ online, identityKey, style }: Props) {
  const opacity = useRef(new Animated.Value(online ? 1 : 0)).current;
  const scale = useRef(new Animated.Value(online ? 1 : 0.55)).current;
  const identityRef = useRef(identityKey);
  const reduceMotionRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) reduceMotionRef.current = enabled;
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      reduceMotionRef.current = enabled;
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    const identityChanged =
      identityKey !== undefined && identityRef.current !== identityKey;
    identityRef.current = identityKey;

    if (identityChanged || reduceMotionRef.current) {
      opacity.setValue(online ? 1 : 0);
      scale.setValue(online ? 1 : 0.55);
      return;
    }

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: online ? 1 : 0,
        duration: FADE_MS,
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: online ? 1 : 0.55,
        duration: FADE_MS,
        useNativeDriver: true,
      }),
    ]).start();
  }, [online, identityKey, opacity, scale]);

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden={!online}
      importantForAccessibility="no-hide-descendants"
      style={[styles.dot, style, { opacity, transform: [{ scale }] }]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: floraColors.greenLight,
    borderWidth: 2,
    borderColor: floraColors.bg,
  },
});
