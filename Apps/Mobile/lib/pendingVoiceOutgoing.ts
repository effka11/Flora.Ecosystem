import { File } from "expo-file-system";

const pendingByAsset = new Map<string, string>();

function isReadableUri(uri: string): boolean {
  try {
    const file = new File(uri);
    return Boolean(file.exists && (file.size ?? 0) > 0);
  } catch {
    return false;
  }
}

export function registerPendingVoiceUri(assetUuid: string, uri: string): void {
  pendingByAsset.set(assetUuid.trim().toLowerCase(), uri);
}

export function peekPendingVoiceUri(assetUuid: string): string | null {
  const key = assetUuid.trim().toLowerCase();
  const uri = pendingByAsset.get(key) ?? null;
  if (!uri) return null;
  if (!isReadableUri(uri)) {
    pendingByAsset.delete(key);
    return null;
  }
  return uri;
}

export function clearPendingVoiceUri(assetUuid: string): void {
  pendingByAsset.delete(assetUuid.trim().toLowerCase());
}
