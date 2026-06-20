import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing } from "react-native";

export type AuthPanelAnim = "none" | "exitLeft" | "enterLeft" | "exitRight" | "enterRight";

const EXIT_MS = 150;
const ENTER_MS = 850;
const SLIDE_OUT = 26;
const SLIDE_IN = 22;

const EXIT_EASING = Easing.bezier(0.4, 0, 1, 1);
const ENTER_EASING = Easing.bezier(0.22, 1, 0.36, 1);

type AuthPanelTransitionProps = {
  anim: AuthPanelAnim;
  children: ReactNode;
};

export function AuthPanelTransition({ anim, children }: AuthPanelTransitionProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (anim === "none") {
      return;
    }

    if (anim === "exitLeft") {
      translateX.setValue(0);
      opacity.setValue(1);
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: -SLIDE_OUT,
          duration: EXIT_MS,
          easing: EXIT_EASING,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: EXIT_MS,
          easing: EXIT_EASING,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    if (anim === "exitRight") {
      translateX.setValue(0);
      opacity.setValue(1);
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: SLIDE_OUT,
          duration: EXIT_MS,
          easing: EXIT_EASING,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: EXIT_MS,
          easing: EXIT_EASING,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    if (anim === "enterLeft") {
      translateX.setValue(SLIDE_IN);
      opacity.setValue(0);
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: 0,
          duration: ENTER_MS,
          easing: ENTER_EASING,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: ENTER_MS,
          easing: ENTER_EASING,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    if (anim === "enterRight") {
      translateX.setValue(-SLIDE_IN);
      opacity.setValue(0);
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: 0,
          duration: ENTER_MS,
          easing: ENTER_EASING,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: ENTER_MS,
          easing: ENTER_EASING,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [anim, opacity, translateX]);

  return (
    <Animated.View
      style={{
        opacity,
        transform: [{ translateX }],
      }}
      pointerEvents={anim === "exitLeft" || anim === "exitRight" ? "none" : "auto"}
    >
      {children}
    </Animated.View>
  );
}

export const AUTH_PANEL_ENTER_MS = ENTER_MS;
export const AUTH_PANEL_EXIT_MS = EXIT_MS;
