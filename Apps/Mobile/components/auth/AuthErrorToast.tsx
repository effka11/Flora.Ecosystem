import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { authStyles } from "./styles";

const AUTO_DISMISS_MS = 4500;

type AuthErrorToastProps = {
  message: string | null;
  onDismiss?: () => void;
};

export function AuthErrorToast({ message, onDismiss }: AuthErrorToastProps) {
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDismissRef = useRef(onDismiss);
  const [visibleMessage, setVisibleMessage] = useState<string | null>(null);

  onDismissRef.current = onDismiss;

  const clearDismissTimer = () => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  };

  const animateIn = () => {
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  const animateOut = (notifyParent: boolean) => {
    clearDismissTimer();
    Animated.timing(progress, {
      toValue: 0,
      duration: 180,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      setVisibleMessage(null);
      if (notifyParent) {
        onDismissRef.current?.();
      }
    });
  };

  useEffect(() => {
    clearDismissTimer();

    if (!message) {
      if (visibleMessage !== null) {
        animateOut(false);
      }
      return clearDismissTimer;
    }

    setVisibleMessage(message);
    animateIn();

    dismissTimer.current = setTimeout(() => {
      animateOut(true);
    }, AUTO_DISMISS_MS);

    return clearDismissTimer;
    // visibleMessage intentionally omitted — only react to message prop changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  useEffect(() => () => clearDismissTimer(), []);

  if (!visibleMessage) {
    return null;
  }

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [28, 0],
  });

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        authStyles.errorToastWrap,
        {
          paddingBottom: Math.max(insets.bottom, 16),
          opacity: progress,
          transform: [{ translateY }],
        },
      ]}
    >
      <Pressable
        style={authStyles.errorToast}
        onPress={() => animateOut(true)}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
      >
        <Text style={authStyles.errorToastText}>{visibleMessage}</Text>
      </Pressable>
    </Animated.View>
  );
}
