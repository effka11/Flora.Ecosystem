import { ActivityIndicator, Pressable, Text } from "react-native";
import { floraColors } from "@/lib/theme";
import { authStyles } from "./styles";

type AuthSubmitButtonProps = {
  label: string;
  loading?: boolean;
  disabled?: boolean;
  whiteTheme?: boolean;
  onPress: () => void;
};

export function AuthSubmitButton({
  label,
  loading = false,
  disabled = false,
  whiteTheme = false,
  onPress,
}: AuthSubmitButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      style={({ pressed }) => [
        authStyles.submit,
        isDisabled ? authStyles.submitDisabled : null,
        pressed && !isDisabled ? authStyles.submitPressed : null,
      ]}
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
    >
      {loading ? (
        <ActivityIndicator color={whiteTheme ? floraColors.whiteTemplate : floraColors.grayLight} />
      ) : (
        <Text style={[authStyles.submitText, whiteTheme ? authStyles.submitTextWhite : null]}>{label}</Text>
      )}
    </Pressable>
  );
}
