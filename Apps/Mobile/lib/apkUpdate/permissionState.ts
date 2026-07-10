import { mmkv } from "@/lib/mmkv";

const PROMPTED_KEY = "apkUpdate.installPermissionPrompted";
const DECLINED_KEY = "apkUpdate.installPermissionDeclined";

export function wasInstallPermissionPrompted(): boolean {
  return mmkv.getString(PROMPTED_KEY) === "1";
}

export function markInstallPermissionPrompted(): void {
  mmkv.set(PROMPTED_KEY, "1");
}

/** User chose «Нет, спасибо» — never show the permission modal again. */
export function wasInstallPermissionDeclined(): boolean {
  return mmkv.getString(DECLINED_KEY) === "1";
}

export function markInstallPermissionDeclined(): void {
  mmkv.set(DECLINED_KEY, "1");
  mmkv.set(PROMPTED_KEY, "1");
}
