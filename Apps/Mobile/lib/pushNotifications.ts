import { apiRegisterPushToken, apiUnregisterPushToken } from "@flora/client-core/api";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  cancelSecurePushConversationNotification,
  ensureSecurePushCapability,
} from "flora-secure-push";
import { isNativePushEnabled } from "@/lib/pushCapabilities";
import { getActiveMessageThread } from "@/lib/activeMessageThread";
import { openMessageFromPush } from "@/lib/openDm";
import { handlePushNotificationData } from "@/lib/realtimeSync";

const PUSH_TOKEN_STORAGE_KEY = "flora.push.token";
const PUSH_SERVER_SYNCED_KEY = "flora.push.serverSynced";
const PUSH_SERVER_FINGERPRINT_KEY = "flora.push.serverFingerprint";

let registeredToken: string | null = null;
let registerInFlight: Promise<void> | null = null;

function logPush(message: string, err?: unknown): void {
  const line = `[push] ${message}`;
  if (err !== undefined) console.warn(line, err);
  else if (__DEV__) console.log(line);
}

function shouldPresentPush(data: Record<string, unknown> | undefined): boolean {
  const type = typeof data?.type === "string" ? data.type : "message";
  // app_update is data-only; no system tray — inbox + «Обновить» only.
  if (type === "app_update") return false;
  if (type !== "message" && type !== "notification") return false;
  if (type === "message" && data) {
    const conv =
      typeof data.conversationUuid === "string" ? data.conversationUuid.trim().toLowerCase() : "";
    if (conv && conv === getActiveMessageThread()) return false;
  }
  return true;
}

/** Убрать push о сообщениях для чата (открыли диалог не из шторки). */
export async function dismissMessagePushNotifications(conversationUuid: string): Promise<void> {
  if (!isNativePushEnabled()) return;
  const norm = conversationUuid.trim().toLowerCase();
  if (!norm) return;

  await Notifications.dismissNotificationAsync(norm).catch(() => undefined);
  await Notifications.dismissNotificationAsync(conversationUuid).catch(() => undefined);
  cancelSecurePushConversationNotification(norm);

  const presented = await Notifications.getPresentedNotificationsAsync();
  for (const notification of presented) {
    const data = notification.request.content.data as Record<string, unknown> | undefined;
    const tag = typeof data?.tag === "string" ? data.tag.trim().toLowerCase() : "";
    const conv =
      typeof data?.conversationUuid === "string" ? data.conversationUuid.trim().toLowerCase() : "";
    if (tag === norm || conv === norm) {
      await Notifications.dismissNotificationAsync(notification.request.identifier).catch(() => undefined);
    }
  }
}

/**
 * Privacy-инвариант (e2e-security.md §Уведомления): содержимое сообщения через
 * FCM не проходит — сервер шлёт только generic-текст. `data.messagePreview`
 * больше не читается (defense-in-depth против старых/чужих payload'ов).
 */
function resolveMessagePushBody(content: Notifications.NotificationContent): string {
  return content.body?.trim() || "Новое сообщение";
}

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    if (!isNativePushEnabled()) {
      return {
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      };
    }
    const data = notification.request.content.data as Record<string, unknown> | undefined;
    const present = shouldPresentPush(data);
    if (!present && typeof data?.conversationUuid === "string") {
      void dismissMessagePushNotifications(data.conversationUuid);
    }
    const resolvedBody = resolveMessagePushBody(notification.request.content);
    if (resolvedBody !== notification.request.content.body) {
      notification.request.content.body = resolvedBody;
    }
    return {
      shouldShowAlert: present,
      shouldPlaySound: present,
      shouldSetBadge: false,
      shouldShowBanner: present,
      shouldShowList: present,
    };
  },
});

async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("messages", {
    name: "Сообщения",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
  });
  await Notifications.setNotificationChannelAsync("notifications", {
    name: "Уведомления",
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

export async function requestPushPermissions(): Promise<boolean> {
  if (!isNativePushEnabled()) return false;
  if (!Device.isDevice) return false;

  await ensureAndroidChannels();

  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === "granted") return true;

  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

export async function obtainDevicePushToken(): Promise<string | null> {
  if (!isNativePushEnabled()) return null;
  if (!Device.isDevice) return null;

  try {
    const tokenResult = await Notifications.getDevicePushTokenAsync();
    const token = tokenResult.data?.trim();
    return token && token.length > 0 ? token : null;
  } catch (err) {
    logPush("getDevicePushTokenAsync failed", err);
    return null;
  }
}

async function isTokenSyncedWithServer(token: string, fingerprint: string): Promise<boolean> {
  try {
    const synced = await SecureStore.getItemAsync(PUSH_SERVER_SYNCED_KEY);
    const stored = await SecureStore.getItemAsync(PUSH_TOKEN_STORAGE_KEY);
    const storedFingerprint = await SecureStore.getItemAsync(PUSH_SERVER_FINGERPRINT_KEY);
    return synced === "1" && stored === token && storedFingerprint === fingerprint;
  } catch {
    return false;
  }
}

async function markTokenSyncedWithServer(token: string, fingerprint: string): Promise<void> {
  registeredToken = token;
  await SecureStore.setItemAsync(PUSH_TOKEN_STORAGE_KEY, token);
  await SecureStore.setItemAsync(PUSH_SERVER_FINGERPRINT_KEY, fingerprint);
  await SecureStore.setItemAsync(PUSH_SERVER_SYNCED_KEY, "1");
}

async function clearTokenSyncState(): Promise<void> {
  registeredToken = null;
  await SecureStore.deleteItemAsync(PUSH_TOKEN_STORAGE_KEY).catch(() => undefined);
  await SecureStore.deleteItemAsync(PUSH_SERVER_FINGERPRINT_KEY).catch(() => undefined);
  await SecureStore.deleteItemAsync(PUSH_SERVER_SYNCED_KEY).catch(() => undefined);
}

export async function registerPushTokenWithServer(ownerUserUuid?: string | null): Promise<void> {
  if (!isNativePushEnabled()) return;
  if (registerInFlight) return registerInFlight;

  registerInFlight = (async () => {
    const granted = await requestPushPermissions();
    if (!granted) {
      logPush("разрешение на уведомления не выдано");
      return;
    }

    const token = await obtainDevicePushToken();
    if (!token) {
      logPush("FCM token не получен (google-services.json в release-сборке?)");
      return;
    }

    let capability: ReturnType<typeof ensureSecurePushCapability> = null;
    if (ownerUserUuid?.trim()) {
      try {
        capability = ensureSecurePushCapability(ownerUserUuid.trim());
      } catch {
        capability = null;
      }
    }
    const fingerprint = JSON.stringify({ token, ownerUserUuid: ownerUserUuid ?? null, capability });

    if (registeredToken === token && (await isTokenSyncedWithServer(token, fingerprint))) return;

    try {
      await apiRegisterPushToken(
        token,
        Platform.OS === "ios" ? "ios" : "android",
        capability ?? undefined,
      );
      await markTokenSyncedWithServer(token, fingerprint);
      logPush("token зарегистрирован на сервере");
    } catch (err) {
      logPush("apiRegisterPushToken failed", err);
    }
  })();

  try {
    await registerInFlight;
  } finally {
    registerInFlight = null;
  }
}

export async function unregisterPushTokenFromServer(): Promise<void> {
  if (!isNativePushEnabled()) {
    await clearTokenSyncState();
    return;
  }
  const token = registeredToken ?? (await SecureStore.getItemAsync(PUSH_TOKEN_STORAGE_KEY)) ?? (await obtainDevicePushToken());
  if (!token) {
    await clearTokenSyncState();
    return;
  }

  await apiUnregisterPushToken(token).catch(() => undefined);
  await clearTokenSyncState();
}

function navigateFromPushData(data: unknown): void {
  void openMessageFromPush(data);
}

export function installPushNotificationListeners(): () => void {
  if (!isNativePushEnabled()) return () => undefined;

  const received = Notifications.addNotificationReceivedListener((notification) => {
    handlePushNotificationData(notification.request.content.data);
  });

  const response = Notifications.addNotificationResponseReceivedListener((response) => {
    handlePushNotificationData(response.notification.request.content.data);
    navigateFromPushData(response.notification.request.content.data);
  });

  return () => {
    received.remove();
    response.remove();
  };
}

export async function handleColdStartPushNavigation(): Promise<void> {
  if (!isNativePushEnabled()) return;
  const last = await Notifications.getLastNotificationResponseAsync();
  if (!last) return;
  handlePushNotificationData(last.notification.request.content.data);
  navigateFromPushData(last.notification.request.content.data);
}

export { PUSH_TOKEN_STORAGE_KEY };
