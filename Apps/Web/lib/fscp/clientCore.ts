import { configureFscpKdf, configureSodiumLoader, type SodiumModule } from "@flora/client-core/fscp";
import { initWebApiClient } from "@/lib/apiClient";
import { deriveKeyArgon2idViaWorker, isKdfWorkerAvailable } from "@/lib/fscp/kdfClient";

let sodiumLoaderConfigured = false;
let fscpKdfConfigured = false;

export async function initWebClientCore(): Promise<void> {
  initWebApiClient();
  if (!sodiumLoaderConfigured) {
    configureSodiumLoader(async () => {
      const mod = await import("libsodium-wrappers-sumo");
      await mod.default.ready;
      return mod.default as unknown as SodiumModule;
    });
    sodiumLoaderConfigured = true;
  }
  if (!fscpKdfConfigured) {
    fscpKdfConfigured = true;
    // SSR / CSP-blocked-worker environments: leave the kernel's injected KDF unset. It falls
    // back to main-thread crypto_pwhash on its own and reports kdf_fallback_used — never throw
    // here just because a worker cannot be created.
    if (isKdfWorkerAvailable()) {
      configureFscpKdf((params) =>
        deriveKeyArgon2idViaWorker({
          passwordBytes: params.passwordBytes,
          salt: params.salt,
          memoryKiB: params.memoryKiB,
          iterations: params.iterations,
          outputLength: params.outputLength,
        }),
      );
    }
  }
}
