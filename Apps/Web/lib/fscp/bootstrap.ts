import { resolveFscpMaterialOnDevice, type FscpBootstrapResult } from "@flora/client-core/fscp";
import { initWebClientCore } from "@/lib/fscp/clientCore";
import { webFscpKeyStorage } from "@/lib/fscp/storage";

export async function webResolveFscpMaterial(
  ownerUserUuid: string,
): Promise<FscpBootstrapResult> {
  await initWebClientCore();
  return resolveFscpMaterialOnDevice({
    storage: webFscpKeyStorage,
    ownerUserUuid,
    preferBackupOverLocal: false,
  });
}
