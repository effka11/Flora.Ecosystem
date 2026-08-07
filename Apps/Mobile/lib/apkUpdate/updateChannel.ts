import { mmkv } from "@/lib/mmkv";

/** APK update channel preference (URLs still resolve via official host until more channels land). */
export type FloraApkUpdateChannelId = "official";

export type FloraApkUpdateChannelOption = {
  id: FloraApkUpdateChannelId;
  label: string;
};

export const FLORA_APK_UPDATE_CHANNELS: readonly FloraApkUpdateChannelOption[] = [
  { id: "official", label: "Официальный" },
] as const;

const CHANNEL_KEY = "apkUpdate.updateChannelId";

function isUpdateChannelId(value: string): value is FloraApkUpdateChannelId {
  return FLORA_APK_UPDATE_CHANNELS.some((c) => c.id === value);
}

export function getUpdateChannelId(): FloraApkUpdateChannelId {
  const raw = mmkv.getString(CHANNEL_KEY);
  if (raw && isUpdateChannelId(raw)) return raw;
  return "official";
}

export function setUpdateChannelId(id: FloraApkUpdateChannelId): void {
  if (!isUpdateChannelId(id)) return;
  mmkv.set(CHANNEL_KEY, id);
}

export function labelForUpdateChannel(id: FloraApkUpdateChannelId): string {
  return FLORA_APK_UPDATE_CHANNELS.find((c) => c.id === id)?.label ?? "Официальный";
}
