import { mmkv } from "@/lib/mmkv";
import {
  defaultNotificationsDraft,
  normalizeNotificationsDraft,
  type SettingsNotificationsDraft,
} from "@/lib/settingsNotificationsDraft";

const STORAGE_KEY = "flora.userSettings.notifications";

export function loadNotificationsDraft(): SettingsNotificationsDraft {
  try {
    const raw = mmkv.getString(STORAGE_KEY);
    if (!raw) return defaultNotificationsDraft();
    return normalizeNotificationsDraft(JSON.parse(raw) as Partial<SettingsNotificationsDraft>);
  } catch {
    return defaultNotificationsDraft();
  }
}

export function saveNotificationsDraft(draft: SettingsNotificationsDraft): void {
  mmkv.set(STORAGE_KEY, JSON.stringify(normalizeNotificationsDraft(draft)));
}
