import { getActiveTabRouteKey } from "@/lib/getActiveTabRouteKey";
import {
  floraRouteKeyframeEasing,
  floraRouteTransitionClearMs,
} from "@/lib/floraRouteEnterFade";
import { shouldSkipFloraMotion } from "@/lib/useFloraReduceMotion";
import { floraColors, floraMotion, floraTabBarHeight } from "@/lib/theme";
import { useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

/** Reveal overlay 1→0 — визуально то же, что content opacity 0→1 на вебе. */
function runFloraRouteRevealFade(overlayOpacity: SharedValue<number>) {
  const { tabTransitionDurationMs, tabTransitionDelayMs } = floraMotion;

  overlayOpacity.value = 1;
  overlayOpacity.value = withDelay(
    tabTransitionDelayMs,
    withTiming(0, {
      duration: tabTransitionDurationMs,
      easing: floraRouteKeyframeEasing,
    }),
  );
}

export function useTabRouteTransition(
  reduceMotion: boolean | null,
  tabBarBottomInset: number,
) {
  const navigation = useNavigation();
  const overlayOpacity = useSharedValue(0);
  const overlayBottom = floraTabBarHeight + tabBarBottomInset;
  const skipAnimation = shouldSkipFloraMotion(reduceMotion);
  const coverActiveRef = useRef(false);
  const revealSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRevealSafetyTimer = useCallback(() => {
    if (revealSafetyTimerRef.current !== null) {
      clearTimeout(revealSafetyTimerRef.current);
      revealSafetyTimerRef.current = null;
    }
  }, []);

  const resetOverlay = useCallback(() => {
    coverActiveRef.current = false;
    clearRevealSafetyTimer();
    cancelAnimation(overlayOpacity);
    overlayOpacity.value = 0;
  }, [clearRevealSafetyTimer, overlayOpacity]);

  const scheduleRevealSafetyReset = useCallback(() => {
    clearRevealSafetyTimer();
    revealSafetyTimerRef.current = setTimeout(() => {
      revealSafetyTimerRef.current = null;
      if (!coverActiveRef.current) {
        return;
      }
      resetOverlay();
    }, floraRouteTransitionClearMs);
  }, [clearRevealSafetyTimer, resetOverlay]);

  const coverContent = useCallback(() => {
    if (skipAnimation) {
      return;
    }

    coverActiveRef.current = true;
    cancelAnimation(overlayOpacity);
    overlayOpacity.value = 1;
    scheduleRevealSafetyReset();
  }, [overlayOpacity, scheduleRevealSafetyReset, skipAnimation]);

  const coverIfSwitchingTab = useCallback(
    (targetRouteKey?: string) => {
      if (skipAnimation || !targetRouteKey) {
        return;
      }

      const state = navigation.getState();
      if (!state) {
        return;
      }

      const activeKey = getActiveTabRouteKey(state);
      if (activeKey === targetRouteKey) {
        return;
      }

      coverContent();
    },
    [coverContent, navigation, skipAnimation],
  );

  const revealContent = useCallback(() => {
    if (skipAnimation) {
      resetOverlay();
      return;
    }

    if (!coverActiveRef.current) {
      return;
    }

    coverActiveRef.current = false;
    clearRevealSafetyTimer();
    cancelAnimation(overlayOpacity);
    runFloraRouteRevealFade(overlayOpacity);
  }, [clearRevealSafetyTimer, overlayOpacity, resetOverlay, skipAnimation]);

  useEffect(() => () => clearRevealSafetyTimer(), [clearRevealSafetyTimer]);

  const screenListeners = useMemo(
    () => ({
      tabPress: (event: { target?: string }) => {
        coverIfSwitchingTab(event.target);
      },
      transitionEnd: () => {
        revealContent();
      },
    }),
    [coverIfSwitchingTab, revealContent],
  );

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  const overlay = (
    <Animated.View
      collapsable={false}
      needsOffscreenAlphaCompositing
      pointerEvents="none"
      renderToHardwareTextureAndroid
      style={[styles.overlay, { bottom: overlayBottom }, overlayStyle]}
    />
  );

  return { screenListeners, overlay };
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: floraColors.bg,
    zIndex: 10,
  },
});
