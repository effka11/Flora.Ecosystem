import { useEffect, useMemo, useRef } from "react";
import {
  AccessibilityInfo,
  Animated,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { floraColors } from "@/lib/theme";

const FADE_MS = 220;

/** Parity with Web `.messagesChatHeaderOnlineBadge` (15×15 on 45px avatar). */
export const ONLINE_STATUS_DOT_SIZE = 15;
export const ONLINE_STATUS_DOT_BORDER = 3.5;
export const ONLINE_STATUS_DOT_INSET = -1;
/** Reference avatar diameter for Messages header / list (Web `--g45`). */
export const ONLINE_STATUS_REF_AVATAR = 45;
/** Profile online badge base on 45px ref (Web `--profile-online-badge-base`). */
export const ONLINE_STATUS_PROFILE_DOT_SIZE = 10;
/** Extra inset so the profile badge sits a bit higher/left of the SE edge. */
export const ONLINE_STATUS_PROFILE_EDGE_NUDGE = 1;

/**
 * Scale badge to avatar; place center on the SE avatar edge (45°).
 * For size=15 on D=45 → inset ≈ −1 (Messages parity).
 * `edgeNudge` pushes the center inward (higher + left from bottom-right).
 */
export function onlineStatusDotLayout(
  avatarDiameter: number,
  sizeAtRef: number = ONLINE_STATUS_DOT_SIZE,
  edgeNudge: number = 0,
): ViewStyle {
  const scale = avatarDiameter / ONLINE_STATUS_REF_AVATAR;
  const size = sizeAtRef * scale;
  const borderWidth = ONLINE_STATUS_DOT_BORDER * (sizeAtRef / ONLINE_STATUS_DOT_SIZE) * scale;
  // R(1 − √2/2) − size/2  →  center sits on circumference at bottom-right
  const edgeInset = (avatarDiameter / 2) * (1 - Math.SQRT1_2);
  const offset = edgeInset - size / 2 + edgeNudge;
  return {
    right: offset,
    bottom: offset,
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth,
  };
}

type Props = {
  online: boolean;
  /**
   * Peer / row identity. When it changes (FlashList recycle or chat switch),
   * animated values snap to the new `online` without cross-fading the previous peer.
   */
  identityKey?: string;
  /** Outer avatar diameter; defaults to Messages 45px reference. */
  avatarDiameter?: number;
  /** Dot diameter at the 45px reference (default 15 = Messages). Profile uses 10. */
  sizeAtRef?: number;
  /** Extra inset (px) toward avatar center from the SE edge. */
  edgeNudge?: number;
  /** Optional extra style; size/position defaults match Web messages badge. */
  style?: StyleProp<ViewStyle>;
};

/** Online status dot with opacity + scale fade (native driver). */
export function OnlineStatusDot({
  online,
  identityKey,
  avatarDiameter,
  sizeAtRef,
  edgeNudge,
  style,
}: Props) {
  const opacity = useRef(new Animated.Value(online ? 1 : 0)).current;
  const scaleAnim = useRef(new Animated.Value(online ? 1 : 0.55)).current;
  const identityRef = useRef(identityKey);
  const reduceMotionRef = useRef(false);
  const layout = useMemo(
    () =>
      onlineStatusDotLayout(
        avatarDiameter ?? ONLINE_STATUS_REF_AVATAR,
        sizeAtRef ?? ONLINE_STATUS_DOT_SIZE,
        edgeNudge ?? 0,
      ),
    [avatarDiameter, sizeAtRef, edgeNudge],
  );

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
      opacity.stopAnimation();
      scaleAnim.stopAnimation();
      opacity.setValue(online ? 1 : 0);
      scaleAnim.setValue(online ? 1 : 0.55);
      return;
    }

    opacity.stopAnimation();
    scaleAnim.stopAnimation();
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: online ? 1 : 0,
        duration: FADE_MS,
        useNativeDriver: true,
      }),
      Animated.timing(scaleAnim, {
        toValue: online ? 1 : 0.55,
        duration: FADE_MS,
        useNativeDriver: true,
      }),
    ]).start();
  }, [online, identityKey, opacity, scaleAnim]);

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden={!online}
      importantForAccessibility="no-hide-descendants"
      style={[styles.dot, layout, style, { opacity, transform: [{ scale: scaleAnim }] }]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    position: "absolute",
    backgroundColor: floraColors.greenLight,
    borderColor: floraColors.bg,
  },
});
