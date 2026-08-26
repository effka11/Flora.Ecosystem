/**
 * Персист кэша замеров текста: гидрация после старта и отложенная запись.
 *
 * Зачем: замеры — это Flora-аналог рассчитанной раскладки Telegram, и в памяти
 * они живут только до конца процесса. После перезапуска приложения первый
 * открытый чат снова гонит окно показа через offscreen-хост, а тот на занятом
 * JS-потоке отвечает сотнями миллисекунд. С диска раскладка приезжает готовой.
 *
 * Запись — debounce, а не throttle: прогрев и открытие чата пишут замеры
 * пачками, и сериализация обязана случаться в тишине ПОСЛЕ них, а не посреди
 * окна открытия. Уход в фон пишет немедленно — процесс могут убить.
 */

import { AppState } from "react-native";
import {
  clearMessageTextMeasures,
  setMessageTextMeasureDirtyListener,
} from "@/lib/messageTextMeasureCache";
import {
  hydrateTextMeasureDisk,
  writeTextMeasureDisk,
} from "@/stores/textMeasureDiskCache";

/** Тишина после последнего замера, после которой снимок уходит на диск. */
const PERSIST_DEBOUNCE_MS = 5000;
/**
 * Гидрация — не первым делом: JSON снимка парсится единым куском, и в первом
 * кадре после старта это отнятый у списка чатов бюджет. Чат пользователь
 * откроет позже, чем через макрозадачу.
 */
const HYDRATE_DELAY_MS = 0;

/** Кого кэш обслуживал в этом процессе — смена владельца обнуляет замеры. */
let servedOwner: string | null = null;

export function startMessageTextMeasurePersist(ownerUserUuid: string): () => void {
  const owner = ownerUserUuid.trim().toLowerCase();
  // Смена аккаунта без промежуточного logout не должна оставить в памяти
  // тексты прошлого владельца.
  if (servedOwner !== null && servedOwner !== owner) clearMessageTextMeasures();
  servedOwner = owner;

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
    writeTextMeasureDisk(ownerUserUuid);
  };

  const hydrateTimer = setTimeout(() => {
    if (stopped) return;
    const hydrated = hydrateTextMeasureDisk(ownerUserUuid);
    if (__DEV__ && hydrated) console.log("[measure-persist] снимок замеров поднят с диска");
  }, HYDRATE_DELAY_MS);

  setMessageTextMeasureDirtyListener(() => {
    if (stopped) return;
    dirty = true;
    clearPersistTimer();
    persistTimer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
  });

  const appSub = AppState.addEventListener("change", (state) => {
    if (state !== "active") flush();
  });

  return () => {
    // Намеренное не теряем: смена владельца или размонтирование провайдера —
    // тоже повод дописать снимок (если с последней записи что-то менялось).
    flush();
    stopped = true;
    clearTimeout(hydrateTimer);
    clearPersistTimer();
    setMessageTextMeasureDirtyListener(null);
    appSub.remove();
  };
}
