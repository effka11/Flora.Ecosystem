import { Ionicons } from "@expo/vector-icons";
import { useRef } from "react";
import {
  Animated,
  Pressable,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { floraColors } from "@/lib/theme";
import { authStyles } from "./styles";

type AuthFieldIcon = "mail" | "lock" | "user" | "at";

const iconMap: Record<AuthFieldIcon, keyof typeof Ionicons.glyphMap> = {
  mail: "mail-outline",
  lock: "lock-closed-outline",
  user: "person-outline",
  at: "at",
};

type AuthFieldProps = TextInputProps & {
  icon: AuthFieldIcon;
  whiteTheme?: boolean;
  showPasswordToggle?: boolean;
  secureVisible?: boolean;
  onToggleSecure?: () => void;
};

export function AuthField({
  icon,
  whiteTheme = false,
  showPasswordToggle = false,
  secureVisible = false,
  onToggleSecure,
  onFocus,
  onBlur,
  style,
  ...inputProps
}: AuthFieldProps) {
  const focusAnim = useRef(new Animated.Value(0)).current;
  const iconColor = whiteTheme ? floraColors.whiteTemplate : "rgba(250, 250, 250, 0.86)";

  const setFocused = (focused: boolean) => {
    Animated.timing(focusAnim, {
      toValue: focused ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  };

  const underlineScale = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.35, 1],
  });

  return (
    <View style={authStyles.fieldBlock}>
      <View style={authStyles.fieldRow}>
        <View style={authStyles.iconCell}>
          <Ionicons name={iconMap[icon]} size={icon === "lock" ? 20 : 18} color={iconColor} />
        </View>
        <View style={authStyles.fieldInputWrap}>
          <TextInput
            {...inputProps}
            style={[authStyles.fieldInput, whiteTheme ? authStyles.fieldInputWhite : null, style]}
            placeholderTextColor={
              whiteTheme ? "rgba(250, 250, 250, 0.68)" : "rgba(143, 143, 143, 0.92)"
            }
            onFocus={(e) => {
              setFocused(true);
              onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocused(false);
              onBlur?.(e);
            }}
          />
          {showPasswordToggle && inputProps.value ? (
            <Pressable
              style={authStyles.passwordToggle}
              onPress={onToggleSecure}
              accessibilityRole="button"
              accessibilityLabel={secureVisible ? "Скрыть пароль" : "Показать пароль"}
            >
              <Ionicons
                name={secureVisible ? "eye-outline" : "eye-off-outline"}
                size={18}
                color={floraColors.whiteTemplate}
              />
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={authStyles.underlineTrack}>
        <Animated.View
          style={[
            authStyles.underlineActive,
            {
              opacity: focusAnim,
              transform: [{ scaleX: underlineScale }],
            },
          ]}
        />
      </View>
    </View>
  );
}
