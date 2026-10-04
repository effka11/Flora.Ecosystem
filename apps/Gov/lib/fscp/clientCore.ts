import { configureSodiumLoader, type SodiumModule } from "@flora/client-core/fscp";
import { initGovApiClient } from "@/lib/govApiClient";

let sodiumLoaderConfigured = false;

/**
 * Civic FSCP crypto bootstrap. Does not import `@flora/fscp`.
 * KDF stays on the kernel main-thread fallback — no kdf-worker on Gov.
 */
export async function initGovClientCore(): Promise<void> {
  initGovApiClient();
  if (sodiumLoaderConfigured) return;
  configureSodiumLoader(async () => {
    const mod = await import("libsodium-wrappers-sumo");
    await mod.default.ready;
    return mod.default as unknown as SodiumModule;
  });
  sodiumLoaderConfigured = true;
}
