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
    preferBackupOverLocal: false,
    authoritativeOverwrite: options?.authoritativeOverwrite ?? false,
  });
}
