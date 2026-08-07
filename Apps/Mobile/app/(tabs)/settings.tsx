import {
  apiBlockUser,
  apiGetBlocklist,
  apiGetKeyBackup,
  isApiRequestError,
} from "@flora/client-core/api";
import { apiDeleteAvatar, apiGetMe, apiUpdateProfile } from "@flora/client-core/auth";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import {
  areSecurePushPreviewsEnabled,
  setSecurePushPreviewsEnabled,
} from "flora-secure-push";
import {
  canRequestPackageInstalls,
  openInstallPermissionSettings,
} from "flora-apk-updater";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  ScrollView,
  Switch,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  Pressable as GesturePressable,
} from "react-native-gesture-handler";
import { LinearGradient } from "expo-linear-gradient";
import Reanimated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  interpolateColor,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ProfileStatusField } from "@/components/profile/ProfileStatusField";
import { TabScreenSearchHeader } from "@/components/TabScreenSearchHeader";
import { avatarUploadErrorMessage, uploadAvatarFromPickerAsset } from "@/lib/avatarUpload";
import { runAppUpdateCatchUp } from "@/lib/apkUpdate/autoUpdate";
import {
  isAutoUpdateEnabled,
  isInAppUpdatesEnabled,
  reconcileInstallPermissionWithOs,
  setAutoUpdateEnabled,
  subscribeUpdatePreferences,
} from "@/lib/apkUpdate/autoUpdatePreference";
import { isSideloadUpdatesEnabled } from "@/lib/apkUpdate/capabilities";
import { openInstallPermissionPrompt } from "@/lib/apkUpdate/installPermissionPrompt";
import { waitForInstallPermissionResult } from "@/lib/apkUpdate/waitForInstallPermission";
import {
  ENERGETIC_OPEN_EASING,
  ENERGETIC_OPEN_MS,
  settleEnergetic,
  snapPagerOffset,
} from "@/lib/energeticSettle";
import {
  schedulePagerMediaWake,
  type PagerMediaWakeHandle,
} from "@/lib/feedPagerMediaWake";
import { mountedSetsEqual, reconcileMountedIds } from "@/lib/settingsMountedSections";
import { floraColors, floraSpacing, floraTabBarContentPadding, floraTabFilter } from "@/lib/theme";
import { useFscpStore } from "@/stores/fscpStore";
import { useSessionStore } from "@/stores/sessionStore";

/** Как feed / messages pager — не перехватывать вертикальный скролл. */
const PAGER_AXIS_PX = 10;
/** Чипы: выше порог, чем pager — тап не уезжает в pan. */
const CHIP_PAN_AXIS_PX = 24;
/** Ниже — без withDecay (короткий жест/тап не запускает инерцию). */
const CHIP_DECAY_MIN_VX = 320;
/** Chip strip: follow pager vs free pan + decay. */
const STRIP_MODE_FOLLOW = 0;
const STRIP_MODE_FREE = 1;
const TABS_PAD_X = floraSpacing.grid;

type TabLayout = { x: number; width: number };

/** Как лента: диапазоны в JS; на UI-потоке только interpolate(scrollX). Полоса чипов тоже от scrollX. */
type TabsChromeMotion = {
  ready: boolean;
  inputRange: number[];
  stripOffset: number[];
  indicatorX: number[];
  indicatorW: number[];
  maxStripOffset: number;
};

function buildTabsChromeMotion(
  sections: readonly SettingsSection[],
  layouts: Partial<Record<SettingsSectionId, TabLayout>>,
  pageWidth: number,
  viewportW: number,
  contentW: number,
): TabsChromeMotion {
  const empty: TabsChromeMotion = {
    ready: false,
    inputRange: [0, 1],
    stripOffset: [0, 0],
    indicatorX: [0, 0],
    indicatorW: [0, 0],
    maxStripOffset: 0,
  };
  const count = sections.length;
  if (count < 1 || pageWidth <= 0 || viewportW <= 0) return empty;
  for (let i = 0; i < count; i++) {
    if (!layouts[sections[i].id]) return empty;
  }

  const maxStripOffset = Math.max(0, contentW - viewportW);
  const inputRange: number[] = [];
  const stripOffset: number[] = [];
  const indicatorX: number[] = [];
  const indicatorW: number[] = [];

  for (let i = 0; i < count; i++) {
    const layout = layouts[sections[i].id]!;
    inputRange.push(i * pageWidth);
    indicatorX.push(layout.x);
    indicatorW.push(layout.width);
    const focus = TABS_PAD_X + layout.x + layout.width / 2;
    const offset =
      maxStripOffset <= 0 ? 0 : Math.max(0, Math.min(maxStripOffset, focus - viewportW / 2));
    stripOffset.push(offset);
  }

  if (inputRange.length === 1) {
    inputRange.push(inputRange[0] + pageWidth);
    stripOffset.push(stripOffset[0]);
    indicatorX.push(indicatorX[0]);
    indicatorW.push(indicatorW[0]);
  }

  return {
    ready: true,
    inputRange,
    stripOffset,
    indicatorX,
    indicatorW,
    maxStripOffset,
  };
}

const SettingsSectionTabLabel = memo(function SettingsSectionTabLabel({
  index,
  label,
  scrollX,
  pageWidth,
  pageCount,
}: {
  index: number;
  label: string;
  scrollX: SharedValue<number>;
  pageWidth: number;
  pageCount: number;
}) {
  // Как лента: цвет только через interpolateColor(scrollX), без чтения SharedValue-массивов.
  const labelStyle = useAnimatedStyle(() => {
    if (pageWidth <= 0 || pageCount <= 0) {
      return { color: floraColors.gray };
    }
    if (pageCount === 1) {
      return { color: floraColors.greenLight };
    }
    if (index <= 0) {
      return {
        color: interpolateColor(
          scrollX.value,
          [0, pageWidth],
          [floraColors.greenLight, floraColors.gray],
        ),
      };
    }
    if (index >= pageCount - 1) {
      return {
        color: interpolateColor(
          scrollX.value,
          [(pageCount - 2) * pageWidth, (pageCount - 1) * pageWidth],
          [floraColors.gray, floraColors.greenLight],
        ),
      };
    }
    return {
      color: interpolateColor(
        scrollX.value,
        [(index - 1) * pageWidth, index * pageWidth, (index + 1) * pageWidth],
        [floraColors.gray, floraColors.greenLight, floraColors.gray],
      ),
    };
  });

  return <Reanimated.Text style={[styles.tabLabel, labelStyle]}>{label}</Reanimated.Text>;
});

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
  keywords: readonly string[];
};

/** Ширина фейда по краям горизонтальных подвкладок. */
const SECTION_TABS_EDGE_FADE = floraSpacing.grid;
const SECTION_TABS_FADE_SOLID = floraColors.bg;
const SECTION_TABS_FADE_CLEAR = "rgba(12, 12, 12, 0)";

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "account",
    label: "Аккаунт",
    description: "Имя, никнейм, почта и параметры профиля.",
    keywords: ["имя", "ник", "аватар", "фото", "статус", "профиль", "выйти", "сохранить", "почта"],
  },
  {
    id: "privacy",
    label: "Приватность",
    description: "Кто видит профиль, статус и переписки.",
    keywords: ["блок", "блокировка", "чёрный список", "блоклист", "приватность"],
  },
  {
    id: "security",
    label: "Безопасность",
    description: "Пароль, сессии и двухфакторная аутентификация.",
    keywords: ["ключ", "e2e", "fscp", "backup", "пароль", "безопасность", "синхронизация"],
  },
  {
    id: "notifications",
    label: "Уведомления",
    description: "Push, почта и оповещения в приложении.",
    keywords: ["push", "сообщения", "обновление", "уведомления", "текст", "фон"],
  },
  {
    id: "customization",
    label: "Кастомизация",
    description: "Тема, язык и оформление интерфейса.",
    keywords: ["тема", "язык", "оформление", "кастомизация", "акцент", "шрифт"],
  },
] as const;

function parseSectionId(value: string | string[] | undefined): SettingsSectionId {
  const raw = Array.isArray(value) ? value[0] : value;
  return SETTINGS_SECTIONS.some((section) => section.id === raw) ? (raw as SettingsSectionId) : "account";
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function matchesSearch(query: string, ...haystacks: readonly (string | null | undefined)[]): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return haystacks.some((item) => (item ?? "").toLowerCase().includes(q));
}

function sectionMatchesSearch(section: SettingsSection, query: string): boolean {
  return matchesSearch(query, section.label, section.description, ...section.keywords);
}

function contentSearchQueryForSection(section: SettingsSection, search: string): string {
  const hasSearch = normalizeSearch(search).length > 0;
  if (hasSearch && matchesSearch(search, section.label, section.description)) return "";
  return search;
}

function SearchableBlock({
  query,
  terms,
  children,
}: {
  query: string;
  terms: readonly string[];
  children: ReactNode;
}) {
  if (!matchesSearch(query, ...terms)) return null;
  return <>{children}</>;
}

function SectionHeader({ section }: { section: SettingsSection }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{section.label}</Text>
      <Text style={styles.sectionDescription}>{section.description}</Text>
    </View>
  );
}

function AccountSettingsTab({ searchQuery }: { searchQuery: string }) {
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

  const avatarVisible = matchesSearch(searchQuery, "аватар", "фото", "профиль");
  const profileVisible = matchesSearch(searchQuery, "имя", "ник", "статус", "профиль", "сохранить", "почта");
  const logoutVisible = matchesSearch(searchQuery, "выйти", "аккаунт", "сессия");
  if (normalizeSearch(searchQuery) && !avatarVisible && !profileVisible && !logoutVisible) {
    return null;
  }

  return (
    <View style={styles.tabBody}>
      {avatarVisible ? (
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
            <Pressable
              style={({ pressed }) => [styles.button, pressed && styles.pressed]}
              onPress={() => void pickAvatar()}
              disabled={avatarBusy}
            >
              {avatarBusy ? (
                <ActivityIndicator color={floraColors.text} />
              ) : (
                <Text style={styles.buttonText}>Выбрать фото</Text>
              )}
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.button, styles.buttonGhost, pressed && styles.pressed]}
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
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {profileVisible ? (
        <>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Имя"
            placeholderTextColor="rgba(250, 250, 250, 0.3)"
          />
          <ProfileStatusField value={status} onChangeText={setStatus} maxLength={150} />
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            onPress={() => void saveProfile()}
          >
            <Text style={styles.buttonText}>Сохранить</Text>
          </Pressable>
        </>
      ) : null}

      {logoutVisible ? (
        <Pressable
          style={({ pressed }) => [styles.button, styles.buttonLogout, pressed && styles.pressed]}
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
      ) : null}
    </View>
  );
}

function PrivacySettingsTab({ searchQuery }: { searchQuery: string }) {
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
      <SearchableBlock query={searchQuery} terms={["блок", "блокировка", "ник", "пользователь"]}>
        <TextInput
          style={styles.input}
          placeholder="Ник пользователя для блокировки"
          placeholderTextColor={floraColors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
        />
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          onPress={() => void blockUser()}
          disabled={busy}
        >
          <Text style={styles.buttonText}>Заблокировать</Text>
        </Pressable>
      </SearchableBlock>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <SearchableBlock query={searchQuery} terms={["блоклист", "чёрный список", "список", "блок"]}>
        <View style={styles.listGroup}>
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
      </SearchableBlock>
    </View>
  );
}

function SecuritySettingsTab({ searchQuery }: { searchQuery: string }) {
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
      <SearchableBlock query={searchQuery} terms={["ключ", "e2e", "fscp", "backup", "pubkey", "статус"]}>
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
      </SearchableBlock>

      <SearchableBlock query={searchQuery} terms={["опубликовать", "заменить", "ключ", "сервер"]}>
        {fscpStatus === "orphan_local_profile" ? (
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            onPress={() => void publishLocalKeyConfirmed()}
          >
            <Text style={styles.buttonText}>Опубликовать локальный ключ</Text>
          </Pressable>
        ) : null}

        {fscpStatus === "key_mismatch" ? (
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            onPress={() => void publishLocalKeyConfirmed()}
          >
            <Text style={styles.buttonText}>Заменить ключ на сервере</Text>
          </Pressable>
        ) : null}
      </SearchableBlock>

      <SearchableBlock query={searchQuery} terms={["пароль", "синхронизация", "backup", "ключ", "аккаунт"]}>
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
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          onPress={() => void restoreKeys()}
        >
          <Text style={styles.buttonText}>Синхронизировать ключи с аккаунтом</Text>
        </Pressable>
        {status ? <Text style={styles.metaText}>{status}</Text> : null}
      </SearchableBlock>
    </View>
  );
}

function NotificationsSettingsTab({ searchQuery }: { searchQuery: string }) {
  const sideload = isSideloadUpdatesEnabled();
  const [showMessageText, setShowMessageText] = useState(() =>
    areSecurePushPreviewsEnabled(),
  );
  const [autoUpdate, setAutoUpdate] = useState(() => isAutoUpdateEnabled());
  const [hasInstallPerm, setHasInstallPerm] = useState(() =>
    sideload ? canRequestPackageInstalls() : false,
  );
  const [permBusy, setPermBusy] = useState(false);
  const [permDeniedMeta, setPermDeniedMeta] = useState(false);

  const refreshUpdatePrefs = () => {
    if (!sideload) return;
    const { hasOs, auto } = reconcileInstallPermissionWithOs();
    setHasInstallPerm(hasOs);
    setAutoUpdate(auto);
    if (hasOs) setPermDeniedMeta(false);
  };

  useEffect(() => {
    if (!sideload) return;
    refreshUpdatePrefs();
    const appSub = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshUpdatePrefs();
    });
    const unsub = subscribeUpdatePreferences(() => refreshUpdatePrefs());
    return () => {
      appSub.remove();
      unsub();
    };
  }, [sideload]);

  const changeShowMessageText = (enabled: boolean) => {
    setShowMessageText(enabled);
    setSecurePushPreviewsEnabled(enabled);
  };

  const changeInAppUpdates = (enabled: boolean) => {
    if (!sideload || permBusy) return;
    setPermDeniedMeta(false);

    if (!enabled && hasInstallPerm) {
      setPermBusy(true);
      void (async () => {
        try {
          const opened = await openInstallPermissionSettings();
          if (opened) {
            await waitForInstallPermissionResult({ mode: "revoke" });
          }
        } catch {
          // Activity missing / native reject — still reconcile.
        } finally {
          refreshUpdatePrefs();
          setPermBusy(false);
        }
      })();
      return;
    }

    if (enabled && !hasInstallPerm) {
      setPermBusy(true);
      void (async () => {
        try {
          const granted = await openInstallPermissionPrompt();
          refreshUpdatePrefs();
          if (!granted || !canRequestPackageInstalls()) {
            setPermDeniedMeta(true);
          }
        } finally {
          setPermBusy(false);
        }
      })();
      return;
    }

    refreshUpdatePrefs();
  };

  const changeAutoUpdate = (enabled: boolean) => {
    if (!sideload) return;
    if (!enabled) {
      setAutoUpdateEnabled(false);
      setAutoUpdate(false);
      return;
    }
    if (!isInAppUpdatesEnabled() || !canRequestPackageInstalls()) {
      setAutoUpdate(false);
      return;
    }
    setAutoUpdateEnabled(true);
    if (!isAutoUpdateEnabled()) {
      setAutoUpdate(false);
      return;
    }
    setAutoUpdate(true);
    setHasInstallPerm(true);
    void runAppUpdateCatchUp({ force: true }).catch(() => undefined);
  };

  const backgroundDisabled = !hasInstallPerm || permBusy;

  return (
    <View style={styles.tabBody}>
      <SearchableBlock query={searchQuery} terms={["текст", "сообщения", "push", "превью", "уведомления"]}>
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}>
            <Text style={styles.bodyText}>Показывать текст сообщений</Text>
            <Text style={styles.metaText}>
              Текст расшифровывается только на этом устройстве. APNs и FCM получают шифротекст.
            </Text>
          </View>
          <Switch
            value={showMessageText}
            onValueChange={changeShowMessageText}
            trackColor={{ false: floraColors.surface, true: floraColors.accentDark }}
            thumbColor={floraColors.whiteTemplate}
          />
        </View>
      </SearchableBlock>
      {sideload ? (
        <>
          <SearchableBlock query={searchQuery} terms={["установка", "обновление", "разрешение", "apk"]}>
            <View style={styles.settingRow}>
              <View style={styles.settingCopy}>
                <Text style={styles.bodyText}>Установка обновлений</Text>
                <Text style={styles.metaText}>
                  Нужно для установки из приложения и для фонового обновления.
                </Text>
                {permDeniedMeta ? (
                  <Text style={styles.metaText}>Разрешение не выдано.</Text>
                ) : null}
              </View>
              <Switch
                value={hasInstallPerm}
                onValueChange={changeInAppUpdates}
                disabled={permBusy}
                trackColor={{ false: floraColors.surface, true: floraColors.accentDark }}
                thumbColor={floraColors.whiteTemplate}
              />
            </View>
          </SearchableBlock>
          <SearchableBlock query={searchQuery} terms={["фон", "обновление", "фоновое"]}>
            <View style={styles.settingRow}>
              <View style={styles.settingCopy}>
                <Text
                  style={[
                    styles.bodyText,
                    backgroundDisabled ? styles.settingDisabledText : null,
                  ]}
                >
                  Фоновое обновление
                </Text>
                <Text
                  style={[
                    styles.metaText,
                    backgroundDisabled ? styles.settingDisabledText : null,
                  ]}
                >
                  Скачивание с канала Flora в фоне; установка при свёрнутом приложении (Android 12+).
                </Text>
              </View>
              <Switch
                value={autoUpdate}
                onValueChange={changeAutoUpdate}
                disabled={backgroundDisabled}
                trackColor={{ false: floraColors.surface, true: floraColors.accentDark }}
                thumbColor={floraColors.whiteTemplate}
              />
            </View>
          </SearchableBlock>
        </>
      ) : null}
      <SearchableBlock query={searchQuery} terms={["push", "release", "sse", "уведомления", "android"]}>
        <Text style={styles.bodyText}>
          Push о новых сообщениях работает в release-сборке Flora. В Flora Dev обновления приходят через интернет
          (SSE), пока приложение открыто.
        </Text>
        <Text style={styles.metaText}>
          Release Android: google-services.json и разрешения уведомлений (см. Apps/Mobile/README.md).
        </Text>
      </SearchableBlock>
    </View>
  );
}

function CustomizationSettingsTab({ searchQuery }: { searchQuery: string }) {
  return (
    <View style={styles.tabBody}>
      <SearchableBlock query={searchQuery} terms={["тема", "тёмная", "оформление"]}>
        <Text style={styles.bodyText}>Тёмная тема Flora активна по умолчанию.</Text>
      </SearchableBlock>
      <SearchableBlock query={searchQuery} terms={["акцент", "шрифт", "кастомизация", "язык"]}>
        <Text style={styles.metaText}>Кастомизация акцентов и шрифтов — в следующих версиях.</Text>
      </SearchableBlock>
    </View>
  );
}

function SettingsTabContent({
  activeSection,
  searchQuery,
}: {
  activeSection: SettingsSectionId;
  searchQuery: string;
}) {
  switch (activeSection) {
    case "privacy":
      return <PrivacySettingsTab searchQuery={searchQuery} />;
    case "security":
      return <SecuritySettingsTab searchQuery={searchQuery} />;
    case "notifications":
      return <NotificationsSettingsTab searchQuery={searchQuery} />;
    case "customization":
      return <CustomizationSettingsTab searchQuery={searchQuery} />;
    case "account":
    default:
      return <AccountSettingsTab searchQuery={searchQuery} />;
  }
}

/** Контент sticky-mount; mid-pan setState запрещён — окно расширяет wake после settle. */
const SettingsSectionPage = memo(function SettingsSectionPage({
  section,
  search,
  pageWidth,
  listPaddingBottom,
  isActive,
}: {
  section: SettingsSection;
  search: string;
  pageWidth: number;
  listPaddingBottom: number;
  isActive: boolean;
}) {
  return (
    <View style={[styles.page, { width: pageWidth }]} collapsable={false}>
      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentInner, { paddingBottom: listPaddingBottom }]}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        scrollEnabled={isActive}
        removeClippedSubviews
      >
        <SectionHeader section={section} />
        <SettingsTabContent
          activeSection={section.id}
          searchQuery={contentSearchQueryForSection(section, search)}
        />
      </ScrollView>
    </View>
  );
});

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { width: pageWidth } = useWindowDimensions();
  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));
  const params = useLocalSearchParams<{ section?: string }>();
  const initialSection = useMemo(() => parseSectionId(params.section), [params.section]);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection);
  const [mountedSectionIds, setMountedSectionIds] = useState<ReadonlySet<SettingsSectionId>>(
    () => new Set([initialSection]),
  );
  const [search, setSearch] = useState("");
  const [tabLayouts, setTabLayouts] = useState<Partial<Record<SettingsSectionId, TabLayout>>>({});
  const [tabsViewportW, setTabsViewportW] = useState(0);
  const [tabsContentW, setTabsContentW] = useState(0);
  const pagerTargetRef = useRef<SettingsSectionId>(initialSection);
  const visibleSectionsRef = useRef<readonly SettingsSection[]>(SETTINGS_SECTIONS);
  const visibleIdsRef = useRef<readonly SettingsSectionId[]>(
    SETTINGS_SECTIONS.map((section) => section.id),
  );
  const mountWakeRef = useRef<PagerMediaWakeHandle | null>(null);

  const scrollX = useSharedValue(0);
  const dragStartX = useSharedValue(0);
  const pageWidthSV = useSharedValue(pageWidth);
  const pageCountSV = useSharedValue(SETTINGS_SECTIONS.length);
  const stripOffsetSV = useSharedValue(0);
  const stripDragStartSV = useSharedValue(0);
  const maxStripOffsetSV = useSharedValue(0);
  const stripModeSV = useSharedValue(STRIP_MODE_FOLLOW);
  /** Bit0 strip settle done, bit1 pager settle done — follow только когда оба. */
  const stripHandoffSV = useSharedValue(0);
  const inputRangeSV = useSharedValue<number[]>([0, 1]);
  const typicalOffsetsSV = useSharedValue<number[]>([0, 0]);

  const hasSearch = normalizeSearch(search).length > 0;
  const visibleSections = useMemo(() => {
    if (!hasSearch) return SETTINGS_SECTIONS;
    return SETTINGS_SECTIONS.filter((section) => sectionMatchesSearch(section, search));
  }, [hasSearch, search]);

  const visibleIds = useMemo(
    () => visibleSections.map((section) => section.id),
    [visibleSections],
  );

  visibleSectionsRef.current = visibleSections;
  visibleIdsRef.current = visibleIds;

  const tabsChrome = useMemo(
    () => buildTabsChromeMotion(visibleSections, tabLayouts, pageWidth, tabsViewportW, tabsContentW),
    [pageWidth, tabLayouts, tabsContentW, tabsViewportW, visibleSections],
  );

  const recordTabLayout = useCallback((id: SettingsSectionId, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[id];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [id]: { x, width } };
    });
  }, []);

  const cancelMountWake = useCallback(() => {
    mountWakeRef.current?.cancel();
    mountWakeRef.current = null;
  }, []);

  const scheduleExpandNeighbors = useCallback(
    (activeIndex: number) => {
      cancelMountWake();
      mountWakeRef.current = schedulePagerMediaWake({
        run: () => {
          mountWakeRef.current = null;
          setMountedSectionIds((prev) => {
            const next = reconcileMountedIds({
              prev,
              visibleIds: visibleIdsRef.current,
              activeIndex,
              expandNeighbors: true,
            });
            return mountedSetsEqual(prev, next) ? prev : next;
          });
        },
      });
    },
    [cancelMountWake],
  );

  const commitPagerIndex = useCallback(
    (index: number) => {
      const next = visibleSectionsRef.current[index];
      if (!next) return;
      pagerTargetRef.current = next.id;
      setActiveSection((current) => (current === next.id ? current : next.id));
      scheduleExpandNeighbors(index);
    },
    [scheduleExpandNeighbors],
  );

  const switchSection = useCallback(
    (next: SettingsSectionId) => {
      const index = visibleSectionsRef.current.findIndex((section) => section.id === next);
      if (index < 0) return;
      if (next === pagerTargetRef.current && Math.abs(scrollX.value - index * pageWidth) < 1) {
        return;
      }
      // Tap не pan: целевую секцию монтируем сразу; active/соседи — после settle+wake.
      pagerTargetRef.current = next;
      setMountedSectionIds((prev) => {
        if (prev.has(next)) return prev;
        const nextSet = new Set(prev);
        nextSet.add(next);
        return nextSet;
      });
      const target = index * pageWidth;
      runOnUI(() => {
        "worklet";
        stripModeSV.value = STRIP_MODE_FREE;
        stripHandoffSV.value = 0;
        cancelAnimation(stripOffsetSV);
        cancelAnimation(scrollX);
        const typicals = typicalOffsetsSV.value;
        const typical =
          index >= 0 && index < typicals.length ? typicals[index]! : stripOffsetSV.value;
        const maxStrip = Math.max(maxStripOffsetSV.value, 1);
        const tryHandoff = () => {
          "worklet";
          if (stripHandoffSV.value === 3) {
            stripModeSV.value = STRIP_MODE_FOLLOW;
            stripHandoffSV.value = 0;
          }
        };
        settleEnergetic(
          stripOffsetSV,
          typical,
          maxStrip,
          1,
          0,
          ENERGETIC_OPEN_MS,
          ENERGETIC_OPEN_EASING,
          (finished) => {
            if (!finished) {
              stripModeSV.value = STRIP_MODE_FOLLOW;
              stripHandoffSV.value = 0;
              return;
            }
            stripHandoffSV.value |= 1;
            tryHandoff();
          },
        );
        const width = pageWidthSV.value;
        settleEnergetic(
          scrollX,
          target,
          width > 0 ? width : 1,
          1,
          0,
          ENERGETIC_OPEN_MS,
          ENERGETIC_OPEN_EASING,
          (finished) => {
            if (!finished) {
              stripModeSV.value = STRIP_MODE_FOLLOW;
              stripHandoffSV.value = 0;
              return;
            }
            stripHandoffSV.value |= 2;
            tryHandoff();
            runOnJS(commitPagerIndex)(index);
          },
        );
      })();
    },
    [
      commitPagerIndex,
      maxStripOffsetSV,
      pageWidth,
      pageWidthSV,
      scrollX,
      stripHandoffSV,
      stripModeSV,
      stripOffsetSV,
      typicalOffsetsSV,
    ],
  );

  useEffect(() => {
    pagerTargetRef.current = initialSection;
    setActiveSection(initialSection);
    setMountedSectionIds(new Set([initialSection]));
    const index = Math.max(
      0,
      visibleIdsRef.current.findIndex((id) => id === initialSection),
    );
    scheduleExpandNeighbors(index);
  }, [initialSection, scheduleExpandNeighbors]);

  useEffect(() => {
    if (visibleSections.length === 0) return;
    if (!visibleSections.some((section) => section.id === activeSection)) {
      const fallback = visibleSections[0].id;
      pagerTargetRef.current = fallback;
      setActiveSection(fallback);
    }
  }, [activeSection, visibleSections]);

  useEffect(() => {
    pageWidthSV.value = pageWidth;
    pageCountSV.value = visibleSections.length;
    const index = Math.max(
      0,
      visibleSections.findIndex((section) => section.id === pagerTargetRef.current),
    );
    cancelAnimation(scrollX);
    scrollX.value = index * pageWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jump on width/filter; animated settles own transitions
  }, [pageCountSV, pageWidth, pageWidthSV, scrollX, visibleSections]);

  // Поиск/фильтр: sync без соседей, затем wake ±1 (не mid-pan).
  useEffect(() => {
    if (visibleIds.length === 0) {
      cancelMountWake();
      setMountedSectionIds(new Set());
      return;
    }
    const index = Math.max(
      0,
      visibleIds.findIndex((id) => id === pagerTargetRef.current),
    );
    setMountedSectionIds((prev) => {
      const next = reconcileMountedIds({
        prev,
        visibleIds,
        activeIndex: index,
        expandNeighbors: false,
      });
      return mountedSetsEqual(prev, next) ? prev : next;
    });
    scheduleExpandNeighbors(index);
  }, [cancelMountWake, scheduleExpandNeighbors, visibleIds]);

  useEffect(() => () => cancelMountWake(), [cancelMountWake]);

  // Синк typical/inputRange/max в UI-thread SV. Не трогаем stripOffsetSV —
  // запись с JS отменяет withTiming/withDecay и ломает follow.
  useEffect(() => {
    if (!tabsChrome.ready) return;
    inputRangeSV.value = tabsChrome.inputRange;
    typicalOffsetsSV.value = tabsChrome.stripOffset;
    maxStripOffsetSV.value = tabsChrome.maxStripOffset;
  }, [
    inputRangeSV,
    maxStripOffsetSV,
    tabsChrome.inputRange,
    tabsChrome.maxStripOffset,
    tabsChrome.ready,
    tabsChrome.stripOffset,
    typicalOffsetsSV,
  ]);

  const showEmpty = hasSearch && visibleSections.length === 0;

  /** follow: полоса = f(scrollX); free: полоса = stripOffsetSV (pan/decay/settle). */
  const tabsTrackStyle = useAnimatedStyle(() => {
    if (stripModeSV.value === STRIP_MODE_FOLLOW) {
      const input = inputRangeSV.value;
      const typical = typicalOffsetsSV.value;
      if (input.length >= 2 && typical.length === input.length) {
        const follow = interpolate(scrollX.value, input, typical, Extrapolation.CLAMP);
        return { transform: [{ translateX: -follow }] };
      }
    }
    return { transform: [{ translateX: -stripOffsetSV.value }] };
  });

  const tabsFadeLeftStyle = useAnimatedStyle(() => {
    let offset = stripOffsetSV.value;
    if (stripModeSV.value === STRIP_MODE_FOLLOW) {
      const input = inputRangeSV.value;
      const typical = typicalOffsetsSV.value;
      if (input.length >= 2 && typical.length === input.length) {
        offset = interpolate(scrollX.value, input, typical, Extrapolation.CLAMP);
      }
    }
    return { opacity: offset > 1 ? 1 : 0 };
  });

  const tabsFadeRightStyle = useAnimatedStyle(() => {
    let offset = stripOffsetSV.value;
    if (stripModeSV.value === STRIP_MODE_FOLLOW) {
      const input = inputRangeSV.value;
      const typical = typicalOffsetsSV.value;
      if (input.length >= 2 && typical.length === input.length) {
        offset = interpolate(scrollX.value, input, typical, Extrapolation.CLAMP);
      }
    }
    return {
      opacity: maxStripOffsetSV.value > 1 && offset < maxStripOffsetSV.value - 1 ? 1 : 0,
    };
  });

  const tabIndicatorStyle = useAnimatedStyle(() => {
    if (!tabsChrome.ready) {
      return { opacity: 0, width: 0, transform: [{ translateX: 0 }] };
    }
    return {
      opacity: 1,
      width: interpolate(
        scrollX.value,
        tabsChrome.inputRange,
        tabsChrome.indicatorW,
        Extrapolation.CLAMP,
      ),
      transform: [
        {
          translateX: interpolate(
            scrollX.value,
            tabsChrome.inputRange,
            tabsChrome.indicatorX,
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  });

  const chipStripPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-CHIP_PAN_AXIS_PX, CHIP_PAN_AXIS_PX])
        .failOffsetY([-CHIP_PAN_AXIS_PX, CHIP_PAN_AXIS_PX])
        .onBegin(() => {
          "worklet";
          // Снять инерцию в момент касания — иначе блокирует тап по чипу.
          cancelAnimation(stripOffsetSV);
        })
        .onStart(() => {
          "worklet";
          // Зафиксировать текущий follow-offset в SV, затем free-pan.
          const input = inputRangeSV.value;
          const typical = typicalOffsetsSV.value;
          if (
            stripModeSV.value === STRIP_MODE_FOLLOW &&
            input.length >= 2 &&
            typical.length === input.length
          ) {
            stripOffsetSV.value = interpolate(
              scrollX.value,
              input,
              typical,
              Extrapolation.CLAMP,
            );
          }
          cancelAnimation(stripOffsetSV);
          stripModeSV.value = STRIP_MODE_FREE;
          stripDragStartSV.value = stripOffsetSV.value;
        })
        .onUpdate((event) => {
          "worklet";
          const max = Math.max(0, maxStripOffsetSV.value);
          const next = stripDragStartSV.value - event.translationX;
          stripOffsetSV.value = next < 0 ? 0 : next > max ? max : next;
        })
        .onEnd((event) => {
          "worklet";
          stripModeSV.value = STRIP_MODE_FREE;
          if (Math.abs(event.velocityX) < CHIP_DECAY_MIN_VX) {
            return;
          }
          stripOffsetSV.value = withDecay({
            velocity: -event.velocityX,
            clamp: [0, Math.max(0, maxStripOffsetSV.value)],
          });
        }),
    [
      inputRangeSV,
      maxStripOffsetSV,
      scrollX,
      stripDragStartSV,
      stripModeSV,
      stripOffsetSV,
      typicalOffsetsSV,
    ],
  );

  const pagerPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-PAGER_AXIS_PX, PAGER_AXIS_PX])
        .failOffsetY([-PAGER_AXIS_PX * 2, PAGER_AXIS_PX * 2])
        .onStart(() => {
          "worklet";
          cancelAnimation(scrollX);
          dragStartX.value = scrollX.value;
          if (stripModeSV.value === STRIP_MODE_FREE) {
            // Только стоп decay. Один settle полосы — на onEnd к typical[target],
            // иначе анимация к «старой» цели + прыжок в follow.
            cancelAnimation(stripOffsetSV);
          } else {
            stripModeSV.value = STRIP_MODE_FOLLOW;
          }
        })
        .onUpdate((event) => {
          "worklet";
          const width = pageWidthSV.value;
          const count = pageCountSV.value;
          if (width <= 0 || count <= 0) return;
          const maxOffset = Math.max(0, count - 1) * width;
          scrollX.value = Math.max(0, Math.min(maxOffset, dragStartX.value - event.translationX));
        })
        .onEnd((event) => {
          "worklet";
          const width = pageWidthSV.value;
          const count = pageCountSV.value;
          if (width <= 0 || count <= 0) return;
          const target = snapPagerOffset(scrollX.value, width, count, event.velocityX);
          const targetIndex = Math.round(target / width);
          const fromFree = stripModeSV.value === STRIP_MODE_FREE;

          const tryStripHandoff = () => {
            "worklet";
            // follow только когда полоса и pager доехали — иначе прыжок к f(scrollX).
            if (stripHandoffSV.value === 3) {
              stripModeSV.value = STRIP_MODE_FOLLOW;
              stripHandoffSV.value = 0;
            }
          };

          if (fromFree) {
            const typicals = typicalOffsetsSV.value;
            const stripTarget =
              targetIndex >= 0 && targetIndex < typicals.length
                ? typicals[targetIndex]!
                : stripOffsetSV.value;
            stripHandoffSV.value = 0;
            cancelAnimation(stripOffsetSV);
            settleEnergetic(
              stripOffsetSV,
              stripTarget,
              Math.max(maxStripOffsetSV.value, 1),
              1,
              0,
              ENERGETIC_OPEN_MS,
              ENERGETIC_OPEN_EASING,
              (finished) => {
                if (!finished) {
                  stripModeSV.value = STRIP_MODE_FOLLOW;
                  stripHandoffSV.value = 0;
                  return;
                }
                stripHandoffSV.value |= 1;
                tryStripHandoff();
              },
            );
            settleEnergetic(
              scrollX,
              target,
              width,
              1,
              event.velocityX,
              ENERGETIC_OPEN_MS,
              ENERGETIC_OPEN_EASING,
              (finished) => {
                if (!finished) {
                  stripModeSV.value = STRIP_MODE_FOLLOW;
                  stripHandoffSV.value = 0;
                  return;
                }
                stripHandoffSV.value |= 2;
                tryStripHandoff();
                runOnJS(commitPagerIndex)(targetIndex);
              },
            );
            return;
          }

          stripModeSV.value = STRIP_MODE_FOLLOW;
          settleEnergetic(
            scrollX,
            target,
            width,
            1,
            event.velocityX,
            ENERGETIC_OPEN_MS,
            ENERGETIC_OPEN_EASING,
            (finished) => {
              stripModeSV.value = STRIP_MODE_FOLLOW;
              if (finished) runOnJS(commitPagerIndex)(targetIndex);
            },
          );
        }),
    [
      commitPagerIndex,
      dragStartX,
      maxStripOffsetSV,
      pageCountSV,
      pageWidthSV,
      scrollX,
      stripHandoffSV,
      stripModeSV,
      stripOffsetSV,
      typicalOffsetsSV,
    ],
  );

  const pagerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -scrollX.value }],
  }));

  return (
    <View style={styles.root}>
      <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
        <TabScreenSearchHeader
          title="Настройки"
          placeholder="Поиск в настройках"
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {showEmpty ? (
        <View style={styles.content}>
          <Text style={styles.emptyHint}>Ничего не найдено. Измените запрос в поиске.</Text>
        </View>
      ) : (
        <View style={styles.pagerShell}>
          <View
            style={styles.tabsScrollWrap}
            onLayout={(event) => {
              const width = event.nativeEvent.layout.width;
              setTabsViewportW((prev) => (prev === width ? prev : width));
            }}
          >
            <GestureDetector gesture={chipStripPan}>
              <Reanimated.View
                style={[styles.tabsTrack, tabsTrackStyle]}
                onLayout={(event) => {
                  const width = event.nativeEvent.layout.width;
                  setTabsContentW((prev) => (prev === width ? prev : width));
                }}
              >
                <View style={styles.tabs}>
                  {tabsChrome.ready ? (
                    <Reanimated.View
                      pointerEvents="none"
                      style={[styles.tabIndicator, tabIndicatorStyle]}
                    />
                  ) : null}
                  {visibleSections.map((item, index) => {
                    const selected = item.id === activeSection;
                    return (
                      <GesturePressable
                        key={item.id}
                        accessibilityRole="tab"
                        accessibilityState={{ selected }}
                        style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
                        onLayout={(event) => recordTabLayout(item.id, event)}
                        onPress={() => switchSection(item.id)}
                      >
                        <SettingsSectionTabLabel
                          index={index}
                          label={item.label}
                          scrollX={scrollX}
                          pageWidth={pageWidth}
                          pageCount={visibleSections.length}
                        />
                      </GesturePressable>
                    );
                  })}
                </View>
              </Reanimated.View>
            </GestureDetector>
            <Reanimated.View pointerEvents="none" style={[styles.tabsFadeLeft, tabsFadeLeftStyle]}>
              <LinearGradient
                colors={[SECTION_TABS_FADE_SOLID, SECTION_TABS_FADE_CLEAR]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
              />
            </Reanimated.View>
            <Reanimated.View pointerEvents="none" style={[styles.tabsFadeRight, tabsFadeRightStyle]}>
              <LinearGradient
                colors={[SECTION_TABS_FADE_CLEAR, SECTION_TABS_FADE_SOLID]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
              />
            </Reanimated.View>
          </View>

          <GestureDetector gesture={pagerPan}>
            <Reanimated.View style={styles.pagerBody}>
              <Reanimated.View
                removeClippedSubviews
                style={[
                  styles.pagerRow,
                  { width: Math.max(pageWidth, pageWidth * Math.max(visibleSections.length, 1)) },
                  pagerStyle,
                ]}
              >
                {visibleSections.map((item) =>
                  mountedSectionIds.has(item.id) ? (
                    <SettingsSectionPage
                      key={item.id}
                      section={item}
                      search={search}
                      pageWidth={pageWidth}
                      listPaddingBottom={listPaddingBottom}
                      isActive={item.id === activeSection}
                    />
                  ) : (
                    <View
                      key={item.id}
                      style={[styles.page, { width: pageWidth }]}
                      collapsable={false}
                    />
                  ),
                )}
              </Reanimated.View>
            </Reanimated.View>
          </GestureDetector>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  topBlock: {
    backgroundColor: floraColors.bg,
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: floraSpacing.gridFine,
    gap: 13,
  },
  pagerShell: {
    flex: 1,
  },
  tabsScrollWrap: {
    position: "relative",
    overflow: "hidden",
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
    backgroundColor: floraColors.bg,
  },
  tabsTrack: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: TABS_PAD_X,
    alignSelf: "flex-start",
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
  },
  tabsFadeLeft: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: SECTION_TABS_EDGE_FADE,
    zIndex: 3,
  },
  tabsFadeRight: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: SECTION_TABS_EDGE_FADE,
    zIndex: 3,
  },
  tabButton: {
    height: floraTabFilter.triggerHeight,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  tabPressed: {
    opacity: 0.72,
  },
  tabLabel: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: floraTabFilter.triggerLabelLineHeight,
  },
  tabIndicator: {
    position: "absolute",
    left: 0,
    bottom: 0,
    height: floraTabFilter.indicatorHeight,
    borderRadius: 999,
    backgroundColor: floraColors.greenLight,
    zIndex: 2,
  },
  pagerBody: {
    flex: 1,
    overflow: "hidden",
  },
  pagerRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
  },
  page: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  contentInner: {
    padding: floraSpacing.grid,
    gap: floraSpacing.grid,
  },
  sectionHeader: {
    gap: floraSpacing.gridFine,
    paddingBottom: floraSpacing.gridFine,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
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
  tabBody: {
    gap: floraSpacing.grid,
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
  },
  settingCopy: {
    flex: 1,
    gap: floraSpacing.gridFine,
  },
  avatarSection: {
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingBottom: floraSpacing.grid,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
  },
  inlineActions: {
    flexDirection: "row",
    gap: floraSpacing.gridFine * 2,
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
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  buttonLogout: {
    backgroundColor: "transparent",
    borderColor: floraColors.error,
    borderWidth: 1,
    minWidth: undefined,
    width: "100%",
    marginTop: floraSpacing.gridFine,
  },
  buttonLogoutText: {
    color: floraColors.error,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  listGroup: {
    borderTopColor: "rgba(250, 250, 250, 0.08)",
    borderTopWidth: 1,
  },
  listRow: {
    color: floraColors.text,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    paddingVertical: floraSpacing.gridFine * 2,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
  },
  subTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 18,
    fontWeight: "300",
    letterSpacing: 0.54,
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
  settingDisabledText: {
    color: floraColors.textMuted,
    opacity: 0.55,
  },
  diag: {
    color: floraColors.textMuted,
    fontSize: 12,
    fontFamily: "monospace",
  },
  error: {
    color: floraColors.error,
  },
  emptyHint: {
    color: floraColors.gray,
    textAlign: "center",
    marginTop: floraSpacing.grid * 3,
    paddingHorizontal: floraSpacing.grid * 2,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
  },
  pressed: {
    opacity: 0.72,
  },
});
