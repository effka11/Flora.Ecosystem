import {
  apiBlockUser,
  apiGetBlocklist,
  apiGetKeyBackup,
  isApiRequestError,
} from "@flora/client-core/api";
import { apiDeleteAvatar, apiGetMe, apiUpdateProfile } from "@flora/client-core/auth";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ProfileStatusField } from "@/components/profile/ProfileStatusField";
import { avatarUploadErrorMessage, uploadAvatarFromPickerAsset } from "@/lib/avatarUpload";
import { floraColors, floraSpacing } from "@/lib/theme";
import { useFscpStore } from "@/stores/fscpStore";
import { useSessionStore } from "@/stores/sessionStore";

type SettingsSectionId =
  | "account"
  | "privacy"
  | "security"
  | "notifications"
  | "customization";

type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  description: string;
};

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "account",
    label: "Аккаунт",
    description: "Имя, никнейм, почта и параметры профиля.",
  },
  {
    id: "privacy",
    label: "Приватность",
    description: "Кто видит профиль, статус и переписки.",
  },
  {
    id: "security",
    label: "Безопасность",
    description: "Пароль, сессии и двухфакторная аутентификация.",
  },
  {
    id: "notifications",
    label: "Уведомления",
    description: "Push, почта и оповещения в приложении.",
  },
  {
    id: "customization",
    label: "Кастомизация",
    description: "Тема, язык и оформление интерфейса.",
  },
] as const;

function parseSectionId(value: string | string[] | undefined): SettingsSectionId {
  const raw = Array.isArray(value) ? value[0] : value;
  return SETTINGS_SECTIONS.some((section) => section.id === raw) ? (raw as SettingsSectionId) : "account";
}

function SectionHeader({ section }: { section: SettingsSection }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{section.label}</Text>
      <Text style={styles.sectionDescription}>{section.description}</Text>
    </View>
  );
}

function AccountSettingsTab() {
  const me = useSessionStore((s) => s.me);
  const setMe = useSessionStore((s) => s.setMe);
  const logout = useSessionStore((s) => s.logout);
  const [displayName, setDisplayName] = useState(me?.displayName ?? "");
  const [status, setStatus] = useState(me?.status ?? "");
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickAvatar = async () => {
    setError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Нужен доступ к галерее для выбора фото.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (result.canceled || !result.assets[0]) return;

    setAvatarBusy(true);
    try {
      await uploadAvatarFromPickerAsset(result.assets[0]);
      const updated = await apiGetMe();
      setMe(updated);
      setAvatarVersion((v) => v + 1);
    } catch (e) {
      setError(avatarUploadErrorMessage(e));
    } finally {
      setAvatarBusy(false);
    }
  };

  const deleteAvatar = async () => {
    if (!me?.avatarUuid) return;
    setError(null);
    setAvatarBusy(true);
    try {
      await apiDeleteAvatar();
      const updated = await apiGetMe();
      setMe(updated);
      setAvatarVersion((v) => v + 1);
    } catch (e) {
      setError(isApiRequestError(e) ? e.message : "Не удалось удалить аватар.");
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveProfile = async () => {
    setError(null);
    try {
      const updated = await apiUpdateProfile({
        displayName,
        username: me?.username ?? "",
        status,
      });
      setMe(updated);
    } catch (e) {
      setError(isApiRequestError(e) ? e.message : "Не удалось сохранить профиль.");
    }
  };

  const handleLogout = async () => {
    setLogoutBusy(true);
    try {
      await logout(false);
      router.replace("/(auth)/login");
    } finally {
      setLogoutBusy(false);
    }
  };

  const confirmLogout = () => {
    Alert.alert("Выйти из аккаунта?", "Сессия на этом устройстве будет завершена.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Выйти",
        style: "destructive",
        onPress: () => void handleLogout(),
      },
    ]);
  };

  return (
    <View style={styles.tabBody}>
      <View style={styles.avatarSection}>
        <FloraAvatar
          size={96}
          avatarUuid={me?.avatarUuid}
          displayName={displayName || me?.displayName || ""}
          username={me?.username ?? ""}
          seed={me?.userUuid}
          cacheVersion={avatarVersion}
        />
        <View style={styles.inlineActions}>
          <Pressable style={styles.button} onPress={() => void pickAvatar()} disabled={avatarBusy}>
            {avatarBusy ? (
              <ActivityIndicator color={floraColors.text} />
            ) : (
              <Text style={styles.buttonText}>Выбрать фото</Text>
            )}
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonGhost]}
            onPress={() => {
              Alert.alert("Удалить аватар?", "Вернётся базовый аватар с буквами.", [
                { text: "Отмена", style: "cancel" },
                { text: "Удалить", style: "destructive", onPress: () => void deleteAvatar() },
              ]);
            }}
            disabled={avatarBusy || !me?.avatarUuid}
          >
            <Text style={styles.buttonText}>Удалить</Text>
          </Pressable>
        </View>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="Имя"
        placeholderTextColor="rgba(250, 250, 250, 0.3)"
      />
      <ProfileStatusField value={status} onChangeText={setStatus} maxLength={150} />
      <Pressable style={styles.button} onPress={() => void saveProfile()}>
        <Text style={styles.buttonText}>Сохранить</Text>
      </Pressable>

      <Pressable
        style={[styles.button, styles.buttonLogout]}
        onPress={confirmLogout}
        disabled={logoutBusy}
        accessibilityRole="button"
        accessibilityLabel="Выйти из аккаунта"
      >
        {logoutBusy ? (
          <ActivityIndicator color={floraColors.whiteTemplate} />
        ) : (
          <Text style={styles.buttonLogoutText}>Выйти</Text>
        )}
      </Pressable>
    </View>
  );
}

function PrivacySettingsTab() {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<unknown[]>([]);

  const loadBlocklist = async () => {
    try {
      const raw = await apiGetBlocklist();
      setItems(Array.isArray(raw) ? raw : []);
      setError(null);
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : "Не удалось загрузить чёрный список.");
    }
  };

  useEffect(() => {
    void loadBlocklist();
  }, []);

  const blockUser = async () => {
    const trimmed = username.trim().replace(/^@+/, "");
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await apiBlockUser(trimmed);
      setUsername("");
      await loadBlocklist();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось заблокировать пользователя.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.tabBody}>
      <TextInput
        style={styles.input}
        placeholder="Ник пользователя для блокировки"
        placeholderTextColor={floraColors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        value={username}
        onChangeText={setUsername}
      />
      <Pressable style={styles.button} onPress={() => void blockUser()} disabled={busy}>
        <Text style={styles.buttonText}>Заблокировать</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.listCard}>
        {items.length > 0 ? (
          items.map((item, index) => {
            const row = item as { userUuid?: string; username?: string; displayName?: string };
            const label = row.displayName || row.username || "Пользователь";
            return (
              <Text key={row.userUuid ?? index} style={styles.listRow}>
                {row.username ? `@${row.username.replace(/^@+/, "")} · ${label}` : label}
              </Text>
            );
          })
        ) : (
          <Text style={styles.metaText}>Блоклист пуст.</Text>
        )}
      </View>
    </View>
  );
}

function SecuritySettingsTab() {
  const me = useSessionStore((s) => s.me);
  const fscpStatus = useFscpStore((s) => s.status);
  const localPubKey = useFscpStore((s) => s.localPubKey);
  const serverPubKey = useFscpStore((s) => s.serverPubKey);
  const restoreWithAccountPassword = useFscpStore((s) => s.restoreWithAccountPassword);
  const publishLocalKeyConfirmed = useFscpStore((s) => s.publishLocalKeyConfirmed);
  const [accountPassword, setAccountPassword] = useState("");
  const [hasServerBackup, setHasServerBackup] = useState<boolean | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiGetKeyBackup()
      .then(() => {
        if (!cancelled) setHasServerBackup(true);
      })
      .catch(() => {
        if (!cancelled) setHasServerBackup(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fscpStatus]);

  const keysMatch =
    localPubKey && serverPubKey
      ? localPubKey.trim() === serverPubKey.trim()
      : null;

  const restoreKeys = async () => {
    if (!me?.userUuid || !accountPassword.trim()) {
      setStatus("Введите пароль аккаунта");
      return;
    }
    try {
      const result = await restoreWithAccountPassword(me.userUuid, accountPassword);
      setStatus(
        result.status === "ready"
          ? "Ключи синхронизированы с аккаунтом. Откройте чат снова."
          : `Синхронизация: ${result.status}`,
      );
      setAccountPassword("");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Ошибка синхронизации");
    }
  };

  return (
    <View style={styles.tabBody}>
      <Text style={styles.subTitle}>E2E ключи</Text>
      <Text style={styles.metaText}>Статус: {fscpStatus}</Text>
      {fscpStatus === "needs_restore" ? (
        <Text style={styles.metaText}>
          Локальных ключей нет. Сначала на вебе обновите backup (Настройки → Безопасность), затем синхронизируйте здесь паролем аккаунта.
        </Text>
      ) : null}
      {fscpStatus === "wrong_password" ? (
        <Text style={styles.metaText}>
          Не удалось открыть backup. Проверьте пароль аккаунта. Если пароль верный — перезалейте backup на вебе и повторите.
        </Text>
      ) : null}
      {fscpStatus === "backup_not_found" ? (
        <Text style={styles.metaText}>
          Backup на сервере не найден. Зайдите на веб и нажмите «Обновить backup сейчас» в Настройках → Безопасность.
        </Text>
      ) : null}
      <Text style={styles.diag}>Локальный pubkey: {localPubKey ? `${localPubKey.slice(0, 16)}…` : "—"}</Text>
      <Text style={styles.diag}>Серверный pubkey: {serverPubKey ? `${serverPubKey.slice(0, 16)}…` : "—"}</Text>
      <Text style={styles.diag}>Backup на сервере: {hasServerBackup === null ? "…" : hasServerBackup ? "есть" : "нет"}</Text>
      <Text style={styles.diag}>Local = server: {keysMatch === null ? "—" : keysMatch ? "да" : "нет"}</Text>

      {fscpStatus === "orphan_local_profile" ? (
        <Pressable style={styles.button} onPress={() => void publishLocalKeyConfirmed()}>
          <Text style={styles.buttonText}>Опубликовать локальный ключ</Text>
        </Pressable>
      ) : null}

      {fscpStatus === "key_mismatch" ? (
        <Pressable style={styles.button} onPress={() => void publishLocalKeyConfirmed()}>
          <Text style={styles.buttonText}>Заменить ключ на сервере</Text>
        </Pressable>
      ) : null}

      <Text style={styles.metaText}>
        Сначала обновите backup на вебе (войдите с паролем), затем синхронизируйте ключи здесь паролем аккаунта.
      </Text>
      <TextInput
        style={styles.input}
        placeholder="Пароль аккаунта"
        placeholderTextColor={floraColors.textMuted}
        secureTextEntry
        value={accountPassword}
        onChangeText={setAccountPassword}
      />
      <Pressable style={styles.button} onPress={() => void restoreKeys()}>
        <Text style={styles.buttonText}>Синхронизировать ключи с аккаунтом</Text>
      </Pressable>
      {status ? <Text style={styles.metaText}>{status}</Text> : null}
    </View>
  );
}

function NotificationsSettingsTab() {
  return (
    <View style={styles.tabBody}>
      <Text style={styles.bodyText}>
        Push о новых сообщениях работает в release-сборке Flora. В Flora Dev обновления приходят через интернет
        (SSE), пока приложение открыто.
      </Text>
      <Text style={styles.metaText}>
        Release Android: google-services.json и разрешения уведомлений (см. Apps/Mobile/README.md).
      </Text>
    </View>
  );
}

function CustomizationSettingsTab() {
  return (
    <View style={styles.tabBody}>
      <Text style={styles.bodyText}>Тёмная тема Flora активна по умолчанию.</Text>
      <Text style={styles.metaText}>Кастомизация акцентов и шрифтов — в следующих версиях.</Text>
    </View>
  );
}

function SettingsTabContent({ activeSection }: { activeSection: SettingsSectionId }) {
  switch (activeSection) {
    case "privacy":
      return <PrivacySettingsTab />;
    case "security":
      return <SecuritySettingsTab />;
    case "notifications":
      return <NotificationsSettingsTab />;
    case "customization":
      return <CustomizationSettingsTab />;
    case "account":
    default:
      return <AccountSettingsTab />;
  }
}

export default function SettingsScreen() {
  const params = useLocalSearchParams<{ section?: string }>();
  const initialSection = useMemo(() => parseSectionId(params.section), [params.section]);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection);

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  const section = SETTINGS_SECTIONS.find((item) => item.id === activeSection) ?? SETTINGS_SECTIONS[0];

  return (
    <View style={styles.root}>
      <View style={styles.navPanel}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.navContent}>
          {SETTINGS_SECTIONS.map((item) => {
            const selected = item.id === activeSection;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                style={({ pressed }) => [styles.navItem, selected && styles.navItemActive, pressed && styles.pressed]}
                onPress={() => setActiveSection(item.id)}
              >
                <Text style={[styles.navLabel, selected && styles.navLabelActive]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner} keyboardShouldPersistTaps="handled">
        <SectionHeader section={section} />
        <View style={styles.panel}>
          <SettingsTabContent activeSection={activeSection} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  navPanel: {
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
    backgroundColor: floraColors.bg,
  },
  navContent: {
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    gap: floraSpacing.gridFine,
  },
  navItem: {
    minHeight: floraSpacing.gridFine * 8,
    borderRadius: 10,
    paddingHorizontal: floraSpacing.grid,
    alignItems: "center",
    justifyContent: "center",
  },
  navItemActive: {
    backgroundColor: "rgba(164, 209, 138, 0.12)",
  },
  navLabel: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  navLabelActive: {
    color: floraColors.greenLight,
  },
  content: {
    flex: 1,
  },
  contentInner: {
    padding: floraSpacing.grid,
    paddingBottom: floraSpacing.grid * 3,
    gap: floraSpacing.grid,
  },
  sectionHeader: {
    gap: floraSpacing.gridFine,
  },
  sectionTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 22,
    fontWeight: "300",
    letterSpacing: 0.66,
  },
  sectionDescription: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
    lineHeight: 20,
  },
  panel: {
    borderColor: "rgba(250, 250, 250, 0.08)",
    borderWidth: 1,
    borderRadius: 14,
    backgroundColor: "rgba(250, 250, 250, 0.02)",
    padding: floraSpacing.grid,
  },
  tabBody: {
    gap: floraSpacing.grid,
  },
  avatarSection: {
    alignItems: "center",
    gap: 14,
    marginBottom: 8,
  },
  inlineActions: {
    flexDirection: "row",
    gap: 10,
  },
  input: {
    backgroundColor: "transparent",
    borderColor: "rgba(250, 250, 250, 0.15)",
    borderWidth: 1,
    borderRadius: 10,
    color: floraColors.whiteTemplate,
    paddingHorizontal: floraSpacing.grid,
    minHeight: floraSpacing.grid * 3,
    fontSize: 15,
    fontWeight: "300",
  },
  button: {
    backgroundColor: floraColors.accentDark,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    minWidth: 120,
  },
  buttonGhost: {
    backgroundColor: floraColors.surface,
    borderColor: floraColors.border,
    borderWidth: 1,
  },
  buttonText: {
    color: floraColors.text,
    fontWeight: "600",
  },
  buttonLogout: {
    backgroundColor: "transparent",
    borderColor: floraColors.error,
    borderWidth: 1,
    minWidth: undefined,
    width: "100%",
    marginTop: floraSpacing.grid,
  },
  buttonLogoutText: {
    color: floraColors.error,
    fontWeight: "600",
  },
  listCard: {
    borderTopColor: "rgba(250, 250, 250, 0.08)",
    borderTopWidth: 1,
  },
  listRow: {
    color: floraColors.text,
    paddingVertical: 10,
    borderBottomColor: floraColors.border,
    borderBottomWidth: 1,
  },
  subTitle: {
    color: floraColors.text,
    fontSize: 18,
    fontWeight: "600",
  },
  bodyText: {
    color: floraColors.text,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
  },
  metaText: {
    color: floraColors.textMuted,
    fontSize: 13,
    fontWeight: "300",
    lineHeight: 19,
  },
  diag: {
    color: floraColors.textMuted,
    fontSize: 12,
    fontFamily: "monospace",
  },
  error: {
    color: floraColors.error,
  },
  pressed: {
    opacity: 0.72,
  },
});
