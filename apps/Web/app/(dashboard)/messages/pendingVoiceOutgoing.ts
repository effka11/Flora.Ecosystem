/** Локальный blob голосового до завершения фоновой отправки (оптимистичный пузырь). */
const pendingVoiceBlobs = new Map<string, Blob>();

export function registerPendingVoiceBlob(assetUuid: string, blob: Blob): void {
  pendingVoiceBlobs.set(assetUuid, blob);
}

export function getPendingVoiceBlob(assetUuid: string): Blob | undefined {
  return pendingVoiceBlobs.get(assetUuid);
}

export function clearPendingVoiceBlob(assetUuid: string): void {
  pendingVoiceBlobs.delete(assetUuid);
}
