import { apiUpdateProfile } from "@flora/client-core/auth";
import { isApiRequestError } from "@flora/client-core/api";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { AuthField } from "@/components/auth/AuthField";
import { AuthFooterLinks } from "@/components/auth/AuthFooterLinks";
import { AuthLogo } from "@/components/auth/AuthLogo";
import { AuthScreenLayout } from "@/components/auth/AuthScreenLayout";
import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { authStyles } from "@/components/auth/styles";
import { mobileSessionStore } from "@/lib/session";
import { useSessionStore } from "@/stores/sessionStore";

export default function CompleteProfileScreen() {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setMe = useSessionStore((s) => s.setMe);
  const logout = useSessionStore((s) => s.logout);

  const onSubmit = async () => {
    const name = displayName.trim();
    const nickname = username.trim().replace(/^@+/, "").toLowerCase();

    if (!name) {
      setError("Введите имя");
      return;
    }
    if (!nickname) {
      setError("Введите никнейм");
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,50}$/.test(nickname)) {
      setError("Никнейм: латиница, цифры и _, от 3 до 50 символов");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const me = await apiUpdateProfile({ displayName: name, username: nickname });
      await mobileSessionStore.setPendingProfileSetup(false);
      setMe(me);
      router.replace("/(tabs)/feed");
    } catch (e) {
      setError(isApiRequestError(e) ? e.message : "Не удалось сохранить профиль");
    } finally {
      setLoading(false);
    }
  };

  const onBack = async () => {
    await logout(false);
    router.replace("/(auth)/login");
  };

  return (
    <AuthScreenLayout loading={loading} error={error} onErrorDismiss={() => setError(null)}>
      <AuthLogo />

      <View style={authStyles.formStack}>
        <AuthField
          icon="user"
          placeholder="Имя"
          autoCapitalize="words"
          value={displayName}
          onChangeText={setDisplayName}
          whiteTheme
        />
        <AuthField
          icon="at"
          placeholder="Никнейм"
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={(value) => setUsername(value.replace(/^@+/, ""))}
          whiteTheme
        />

        <AuthSubmitButton label="Продолжить" loading={loading} whiteTheme onPress={onSubmit} />
      </View>

      <AuthFooterLinks variant="profile" onBack={onBack} />
    </AuthScreenLayout>
  );
}
