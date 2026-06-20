import { syncFscpOnLogin, type SyncFscpOnLoginResult } from "@flora/client-core/fscp";
import { initWebClientCore } from "@/lib/fscp/clientCore";
import { webFscpKeyStorage } from "@/lib/fscp/storage";

export async function webSyncFscpOnLogin(
  ownerUserUuid: string,
  accountPassword: string,
  options?: { authoritativeOverwrite?: boolean },
): Promise<SyncFscpOnLoginResult> {
  await initWebClientCore();
  return syncFscpOnLogin({
    storage: webFscpKeyStorage,
    ownerUserUuid,
    accountPassword,
    preferBackupOverLocal: false,
    // Web is the authoritative backup keeper. Create/heal the backup only when the password was
    // just proven current (successful login / registration). Inline unlock passes false.
    authoritativeOverwrite: options?.authoritativeOverwrite ?? false,
  });
}
