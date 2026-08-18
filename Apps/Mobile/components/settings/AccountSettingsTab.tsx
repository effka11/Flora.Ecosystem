import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  Text,
  View,
} from "react-native";
// RNGH TextInput: при активации pager-pan получает ACTION_CANCEL — иначе
// EditText ведёт курсор и рисует лупу выделения весь горизонтальный свайп.
import { TextInput } from "react-native-gesture-handler";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ProfileStatusField } from "@/components/profile/ProfileStatusField";
import { BirthDateField } from "@/components/settings/BirthDateField";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import { floraColors } from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";
import { useSettingsDraftStore } from "@/stores/settingsDraftStore";

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function matchesSearch(query: string, ...haystacks: readonly (string | null | undefined)[]): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return haystacks.some((item) => (item ?? "").toLowerCase().includes(q));
}

type AccountSettingsTabProps = {
  searchQuery: string;
};

export function AccountSettingsTab({ searchQuery }: AccountSettingsTabProps) {
  const me = useSessionStore((s) => s.me);
  const logout = useSessionStore((s) => s.logout);
  const account = useSettingsDraftStore((s) => s.account);
  const updateAccount = useSettingsDraftStore((s) => s.updateAccount);
  const avatarPending = useSettingsDraftStore((s) => s.avatarPending);
  const setAvatarPending = useSettingsDraftStore((s) => s.setAvatarPending);
  const saveError = useSettingsDraftStore((s) => s.saveError);
  const saveSuccess = useSettingsDraftStore((s) => s.saveSuccess);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const error = localError ?? saveError;
  const success = saveSuccess;

  const serverHasAvatar = Boolean(me?.avatarUuid);
  const previewUri = avatarPending?.kind === "upload" ? avatarPending.asset.uri : null;
  const displayAvatarUuid =
    avatarPending?.kind === "remove" ? null : avatarPending?.kind === "upload" ? null : me?.avatarUuid;
  const canDeleteAvatar =
    avatarPending?.kind === "upload" || (serverHasAvatar && avatarPending?.kind !== "remove");

  const pickAvatar = async () => {
    setLocalError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setLocalError("Нужен доступ к галерее для выбора фото.");
      return;
    }
    setPickerBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      if (result.canceled || !result.assets[0]) return;
      setAvatarPending({ kind: "upload", asset: result.assets[0] });
    } finally {
      setPickerBusy(false);
    }
  };

  const queueDeleteAvatar = () => {
    setLocalError(null);
    if (avatarPending?.kind === "upload") {
      // Сброс локального выбора → снова серверный аватар.
      setAvatarPending(null);
      return;
    }
    if (!serverHasAvatar) return;
    setAvatarPending({ kind: "remove" });
  };

  const handleLogout = async () => {
    setLocalError(null);
    setLogoutBusy(true);
    try {
      await logout(false);
      router.replace("/(auth)/login");
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Не удалось выйти из аккаунта.");
      setLogoutBusy(false);
    }
  };

  const confirmLogout = () => {
    Alert.alert("Выйти из аккаунта?", "Завершить текущую сессию на этом устройстве", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Выйти",
        style: "destructive",
        onPress: () => void handleLogout(),
      },
    ]);
  };

  const avatarVisible = matchesSearch(searchQuery, "аватар", "фото", "профиль");
  const profileVisible = matchesSearch(
    searchQuery,
    "имя",
    "ник",
    "никнейм",
    "статус",
    "описание",
    "профиль",
    "сохранить",
    "дата",
    "рождение",
  );
  const logoutVisible = matchesSearch(searchQuery, "выйти", "аккаунт", "сессия");
  if (normalizeSearch(searchQuery) && !avatarVisible && !profileVisible && !logoutVisible) {
    return null;
  }

  return (
    <View style={ui.tabBody}>
      {avatarVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Аватар</Text>
          <View style={ui.avatarRow}>
            <FloraAvatar
              size={105}
              avatarUuid={displayAvatarUuid}
              previewUri={previewUri}
              displayName={account.displayName || me?.displayName || ""}
              username={account.username || me?.username || ""}
              seed={me?.userUuid}
              accountBlocked={me?.accountBlocked}
            />
            <View style={ui.avatarActions}>
              <Pressable
                style={({ pressed }) => [ui.textAction, pressed && ui.pressed]}
                onPress={() => void pickAvatar()}
                disabled={pickerBusy}
              >
                {pickerBusy ? (
                  <ActivityIndicator color={floraColors.greenLight} />
                ) : (
                  <Text style={ui.textActionPrimary}>Изменить аватар</Text>
                )}
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  ui.textAction,
                  (!canDeleteAvatar || pickerBusy) && ui.textActionDisabled,
                  pressed && ui.pressed,
                ]}
                onPress={() => {
                  if (avatarPending?.kind === "upload") {
                    queueDeleteAvatar();
                    return;
                  }
                  Alert.alert("Удалить аватар?", "Изменение применится после сохранения.", [
                    { text: "Отмена", style: "cancel" },
                    { text: "Удалить", style: "destructive", onPress: queueDeleteAvatar },
                  ]);
                }}
                disabled={!canDeleteAvatar || pickerBusy}
              >
                <Text style={ui.textActionMuted}>Удалить аватар</Text>
              </Pressable>
            </View>
          </View>
          {error ? <Text style={ui.feedbackError}>{error}</Text> : null}
          {success ? <Text style={ui.feedbackSuccess}>{success}</Text> : null}
        </View>
      ) : null}

      {profileVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Личная информация</Text>
          {!avatarVisible && error ? <Text style={ui.feedbackError}>{error}</Text> : null}
          {!avatarVisible && success ? <Text style={ui.feedbackSuccess}>{success}</Text> : null}
          <View style={ui.fieldsStack}>
            <View style={ui.fieldGroup}>
              <Text style={ui.fieldLabel}>Имя</Text>
              <TextInput
                style={ui.input}
                value={account.displayName}
                onChangeText={(value) => updateAccount({ displayName: value })}
                autoComplete="name"
                placeholderTextColor="rgba(250, 250, 250, 0.3)"
              />
            </View>
            <View style={ui.fieldGroup}>
              <Text style={ui.fieldLabel}>Никнейм</Text>
              <TextInput
                style={ui.input}
                value={account.username}
                onChangeText={(value) =>
                  updateAccount({ username: value.replace(/^@+/, "").toLowerCase() })
                }
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                placeholderTextColor="rgba(250, 250, 250, 0.3)"
              />
            </View>
            <BirthDateField
              value={account.birthDate}
              onChange={(next) => updateAccount({ birthDate: next })}
            />
            <ProfileStatusField
              value={account.status}
              onChangeText={(value) => updateAccount({ status: value })}
              maxLength={150}
              placeholder=""
            />
          </View>
        </View>
      ) : null}

      {logoutVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Сессия</Text>
          <View style={ui.fieldsStack}>
            <Text style={ui.sectionHint}>Завершить текущую сессию на этом устройстве</Text>
            <Pressable
              style={({ pressed }) => [
                ui.dangerOutlineButton,
                pressed && ui.pressed,
                logoutBusy && ui.textActionDisabled,
              ]}
              onPress={confirmLogout}
              disabled={logoutBusy}
              accessibilityRole="button"
              accessibilityLabel="Выйти из аккаунта"
            >
              {logoutBusy ? (
                <ActivityIndicator color="#f6a8a8" />
              ) : (
                <Text style={ui.dangerOutlineButtonText}>Выйти</Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
