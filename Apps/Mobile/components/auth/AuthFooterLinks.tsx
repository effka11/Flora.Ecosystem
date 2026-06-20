import { Pressable, Text, View } from "react-native";
import { authStyles } from "./styles";

type AuthFooterLinksProps =
  | {
      variant: "login";
      onCreate: () => void;
    }
  | {
      variant: "register";
      onLogin: () => void;
    }
  | {
      variant: "verify";
      onWrongEmail: () => void;
      onLogin: () => void;
    }
  | {
      variant: "profile";
      onBack: () => void;
    };

export function AuthFooterLinks(props: AuthFooterLinksProps) {
  if (props.variant === "profile") {
    return (
      <View style={authStyles.links}>
        <Pressable onPress={props.onBack} accessibilityRole="button">
          <Text style={authStyles.backLink}>Назад к аутентификации</Text>
        </Pressable>
      </View>
    );
  }

  if (props.variant === "verify") {
    return (
      <View style={authStyles.links}>
        <Pressable onPress={props.onWrongEmail} accessibilityRole="button">
          <Text style={authStyles.linkMuted}>Неверный email</Text>
        </Pressable>
        <Text style={authStyles.linkMuted} accessibilityElementsHidden>
          →
        </Text>
        <Pressable onPress={props.onLogin} accessibilityRole="button">
          <Text style={authStyles.linkAccent}>На вход</Text>
        </Pressable>
      </View>
    );
  }

  if (props.variant === "register") {
    return (
      <View style={authStyles.links}>
        <Pressable onPress={props.onLogin} accessibilityRole="button">
          <Text style={authStyles.linkMuted}>Уже есть аккаунт</Text>
        </Pressable>
        <Text style={authStyles.linkMuted} accessibilityElementsHidden>
          →
        </Text>
        <Pressable onPress={props.onLogin} accessibilityRole="button">
          <Text style={authStyles.linkAccent}>Войти</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={authStyles.links}>
      <Pressable onPress={props.onCreate} accessibilityRole="button">
        <Text style={authStyles.linkMuted}>У меня нет аккаунта</Text>
      </Pressable>
      <Text style={authStyles.linkMuted} accessibilityElementsHidden>
        →
      </Text>
      <Pressable onPress={props.onCreate} accessibilityRole="button">
        <Text style={authStyles.linkAccent}>Создать</Text>
      </Pressable>
    </View>
  );
}
