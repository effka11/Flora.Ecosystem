/**
 * Контейнер расшифрованных хвостов: открытие после входа и отложенная запись.
 *
 * Гидрация на холодном старте синхронная, до первого кадра списка
 * (`hydrateDecryptWarmDisk` в bootstrap). Здесь — только запись: debounce после
 * пачки decrypt и немедленный flush при уходе в фон, пока процесс не убили.
 */

import { AppState } from "react-native";
import { messageThreadCache, setDecryptWarmDirtyListener } from "@/stores/messageThreadCache";
import {
  decryptWarmHydratedOwner,
  hydrateDecryptWarmDisk,
  writeDecryptWarmDisk,
} from "@/stores/decryptWarmDiskCache";

/** Тишина после последней терминальной строки, затем снимок уходит в контейнер. */
const PERSIST_DEBOUNCE_MS = 1500;

let servedOwner: string | null = null;

export function startDecryptWarmPersist(ownerUserUuid: string): () => void {
  const owner = ownerUserUuid.trim().toLowerCase();
  if (servedOwner !== null && servedOwner !== owner) {
    messageThreadCache.clearDecryptCaches();
  }
  servedOwner = owner;
  if (decryptWarmHydratedOwner() !== owner) hydrateDecryptWarmDisk(ownerUserUuid);

  let stopped = false;
  let dirty = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPersistTimer = (): void => {
    if (persistTimer != null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
  };

  const flush = (): void => {
    clearPersistTimer();
    if (stopped || !dirty) return;
    dirty = false;
    writeDecryptWarmDisk(ownerUserUuid);
  };

  setDecryptWarmDirtyListener(() => {
    if (stopped) return;
    dirty = true;
    clearPersistTimer();
    persistTimer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
  });

  const appSub = AppState.addEventListener("change", (state) => {
    if (state !== "active") flush();
  });

  return () => {
    flush();
    stopped = true;
    clearPersistTimer();
    setDecryptWarmDirtyListener(null);
    appSub.remove();
  };
}
