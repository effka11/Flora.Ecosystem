/**
 * Background / silent APK auto-update is disabled.
 * Updates run only from the inbox «Обновить» button (`runUserUpdateFromNotification`).
 */

/** @deprecated No-op — background auto-update removed. */
export async function runAutoUpdateFromManifest(_manifest: unknown): Promise<void> {
  return;
}

/** @deprecated No-op — background auto-update removed. */
export async function runAutoUpdateFromRealtime(_input: unknown): Promise<void> {
  return;
}

/** @deprecated No-op — background auto-update removed. */
export async function runAppUpdateCatchUp(): Promise<void> {
  return;
}
