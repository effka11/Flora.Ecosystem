import { getActiveTabRouteKey, getActiveTabRouteName } from "@/lib/getActiveTabRouteKey";
import {
  floraRouteRevealEasing,
  floraRouteTransitionClearMs,
} from "@/lib/floraRouteEnterFade";
import { bindRouteTransitionBusy } from "@/lib/routeTransitionBusy";
import { clearScrollActivityOwner } from "@/lib/scrollActivity";
import {
  registerTabRouteCoverHandler,
  registerTabRouteRevealHandler,
  shouldCoverTabSwitch,
} from "@/lib/tabRouteCover";
import { shouldSkipFloraMotion } from "@/lib/useFloraReduceMotion";
import { floraColors, floraMotion, floraTabBarContentHeight } from "@/lib/theme";
import { useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

/** Reveal overlay 1→0 — duration-2 + ease-out quad, не слайд подвкладок. */
function runFloraRouteRevealFade(
  overlayOpacity: SharedValue<number>,
  onFinished: () => void,
) {
  overlayOpacity.value = 1;
  overlayOpacity.value = withTiming(
    0,
    {
      duration: floraMotion.tabTransitionDurationMs,
      easing: floraRouteRevealEasing,
    },
    (finished) => {
      if (finished) {
        runOnJS(onFinished)();
      }
    },
  );
}

export function useTabRouteTransition(
  reduceMotion: boolean | null,
  tabBarBottomInset: number,
) {
  const navigation = useNavigation();
  const overlayOpacity = useSharedValue(0);
  const overlayBottom = floraTabBarContentHeight() + tabBarBottomInset;
  const skipAnimation = shouldSkipFloraMotion(reduceMotion);
  const coverActiveRef = useRef(false);
  const revealSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routeBusyOwner = useRef(Symbol("tab-route-transition")).current;
  const [routeBusy] = useState(() => bindRouteTransitionBusy(routeBusyOwner));

  const clearRevealSafetyTimer = useCallback(() => {
    if (revealSafetyTimerRef.current !== null) {
      clearTimeout(revealSafetyTimerRef.current);
      revealSafetyTimerRef.current = null;
    }
  }, []);

  const resetOverlay = useCallback(() => {
    coverActiveRef.current = false;
    routeBusy.reset();
    clearRevealSafetyTimer();
    cancelAnimation(overlayOpacity);
    overlayOpacity.value = 0;
  }, [clearRevealSafetyTimer, overlayOpacity, routeBusy]);

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
    const { finish } = routeBusy.reveal();
    revealSafetyTimerRef.current = setTimeout(() => {
      revealSafetyTimerRef.current = null;
      finish();
    }, floraRouteTransitionClearMs);
    runFloraRouteRevealFade(overlayOpacity, () => {
      clearRevealSafetyTimer();
      finish();
    });
  }, [clearRevealSafetyTimer, overlayOpacity, resetOverlay, routeBusy, skipAnimation]);

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
    routeBusy.cover();
    cancelAnimation(overlayOpacity);
    overlayOpacity.value = 1;
    scheduleRevealSafetyReset();
  }, [overlayOpacity, routeBusy, scheduleRevealSafetyReset, skipAnimation]);

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

  const coverIfSwitchingName = useCallback(
    (targetTabName: string) => {
      if (skipAnimation || targetTabName.length === 0) {
        return;
      }

      const state = navigation.getState();
      if (!state) {
        return;
      }

      const activeName = getActiveTabRouteName(state);
      if (!shouldCoverTabSwitch(activeName, targetTabName)) {
        return;
      }

      coverContent();
    },
    [coverContent, navigation, skipAnimation],
  );

  useEffect(() => {
    registerTabRouteCoverHandler(coverIfSwitchingName);
    registerTabRouteRevealHandler(revealContent);
    return () => {
      registerTabRouteCoverHandler(null);
      registerTabRouteRevealHandler(null);
    };
  }, [coverIfSwitchingName, revealContent]);

  useEffect(
    () => () => {
      clearRevealSafetyTimer();
      routeBusy.dispose();
      clearScrollActivityOwner(routeBusyOwner);
    },
    [clearRevealSafetyTimer, routeBusy, routeBusyOwner],
  );

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
