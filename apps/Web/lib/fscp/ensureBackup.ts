import { ensureKeyBackupOnServer } from "@flora/client-core/fscp";
import { initWebClientCore } from "@/lib/fscp/clientCore";
import type { FscpLocalMaterial } from "@flora/client-core/fscp";

export async function webEnsureKeyBackupOnServer(
  ownerUserUuid: string,
  accountPassword: string,
  material: FscpLocalMaterial,
): Promise<{ uploaded: boolean; skippedReason?: string }> {
  await initWebClientCore();
  // Settings → "manage keys" is a deliberate, explicit password entry by the user to (re)create
  // the server backup — the manual authoritative path (like login/registration). Automatic and
  // inline-restore paths stay restore-only. The user sees the current revision before acting.
  return ensureKeyBackupOnServer({
    ownerUserUuid,
    accountPassword,
    material,
    authoritativeOverwrite: true,
  });
}
