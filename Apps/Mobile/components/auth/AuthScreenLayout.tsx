import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthErrorToast } from "./AuthErrorToast";
import { authStyles } from "./styles";

type AuthScreenLayoutProps = {
  children: ReactNode;
  loading?: boolean;
  error?: string | null;
  onErrorDismiss?: () => void;
};

export function AuthScreenLayout({
  children,
  loading = false,
  error = null,
  onErrorDismiss,
}: AuthScreenLayoutProps) {
  const insets = useSafeAreaInsets();
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!loading) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 700,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [loading, spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <KeyboardAvoidingView
      style={authStyles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          authStyles.scrollContent,
          { paddingTop: Math.max(insets.top, 16), paddingBottom: Math.max(insets.bottom, 28) },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={authStyles.inner}>{children}</View>
      </ScrollView>
      {loading ? (
        <View style={authStyles.busyOverlay} accessibilityState={{ busy: true }}>
          <Animated.View style={[authStyles.busyDot, { transform: [{ rotate }] }]} />
        </View>
      ) : null}
      <AuthErrorToast message={error} onDismiss={onErrorDismiss} />
    </KeyboardAvoidingView>
  );
}
