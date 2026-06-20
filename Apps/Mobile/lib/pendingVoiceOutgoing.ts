const pendingByAsset = new Map<string, string>();

export function registerPendingVoiceUri(assetUuid: string, uri: string): void {
  pendingByAsset.set(assetUuid.trim().toLowerCase(), uri);
}

export function peekPendingVoiceUri(assetUuid: string): string | null {
  return pendingByAsset.get(assetUuid.trim().toLowerCase()) ?? null;
}

export function clearPendingVoiceUri(assetUuid: string): void {
  pendingByAsset.delete(assetUuid.trim().toLowerCase());
}
