import { syncFscpOnLogin, type SyncFscpOnLoginResult } from "@flora/client-core/fscp";
import { initGovClientCore } from "@/lib/fscp/clientCore";
import { govFscpKeyStorage } from "@/lib/fscp/storage";

export async function govSyncFscpOnLogin(
  ownerUserUuid: string,
  accountPassword: string,
  options?: { authoritativeOverwrite?: boolean },
): Promise<SyncFscpOnLoginResult> {
  await initGovClientCore();
  return syncFscpOnLogin({
    storage: govFscpKeyStorage,
    ownerUserUuid,
    accountPassword,
    // Civic origin is restore-only for identity: never publish a stale Gov vault
    // over Social `user_e2e_keys`. Password login/unlock replaces local from backup.
    preferBackupOverLocal: false,
    forceRestoreFromBackupOnLogin: true,
    autoPublishOnMismatch: false,
    authoritativeOverwrite: options?.authoritativeOverwrite ?? false,
  });
}
