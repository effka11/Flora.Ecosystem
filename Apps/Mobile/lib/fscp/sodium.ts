import { Platform } from "react-native";
import {
  configureSodiumLoader,
  type SodiumModule,
} from "@flora/client-core/fscp";
import sodium, {
  crypto_pwhash,
  crypto_pwhash_ALG_ARGON2ID13,
  crypto_pwhash_SALTBYTES,
  loadSumoVersion,
} from "react-native-libsodium";

let configured = false;

function toSodiumModule(): SodiumModule {
  const mod = sodium as unknown as SodiumModule;
  if (typeof mod.crypto_pwhash === "function") {
    return mod;
  }
  if (typeof crypto_pwhash !== "function") {
    throw new Error(
      "react-native-libsodium: crypto_pwhash недоступен. " +
        "Пересоберите dev-client (expo run:android/ios) или на web вызовите loadSumoVersion().",
    );
  }
  return {
    ...mod,
    crypto_pwhash,
    crypto_pwhash_ALG_ARGON2ID13,
    crypto_pwhash_SALTBYTES,
  };
}

export async function initMobileSodium(): Promise<void> {
  if (configured) return;
  configured = true;
  if (Platform.OS === "web") {
    loadSumoVersion();
  }
  configureSodiumLoader(async () => {
    await sodium.ready;
    return toSodiumModule();
  });
}
