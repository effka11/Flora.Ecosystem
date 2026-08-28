import { resolveFscpMaterialOnDevice, type FscpBootstrapResult } from "@flora/client-core/fscp";
import { initGovClientCore } from "@/lib/fscp/clientCore";
import { govFscpKeyStorage } from "@/lib/fscp/storage";

export async function govResolveFscpMaterial(
  ownerUserUuid: string,
): Promise<FscpBootstrapResult> {
  await initGovClientCore();
  return resolveFscpMaterialOnDevice({
    storage: govFscpKeyStorage,
    ownerUserUuid,
    preferBackupOverLocal: false,
  });
}
