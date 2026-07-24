import { configureSodiumLoader, type SodiumModule } from "@flora/client-core/fscp";
import { initWebApiClient } from "@/lib/apiClient";

let sodiumLoaderConfigured = false;

export async function initWebClientCore(): Promise<void> {
  initWebApiClient();
  if (sodiumLoaderConfigured) return;
  configureSodiumLoader(async () => {
    const mod = await import("libsodium-wrappers-sumo");
    await mod.default.ready;
    return mod.default as unknown as SodiumModule;
  });
  sodiumLoaderConfigured = true;
}
