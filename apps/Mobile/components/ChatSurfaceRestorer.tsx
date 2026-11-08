import { usePathname, useSegments, router } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { isChatPickActivityActive } from "@/lib/chatPickActivity";
import { takeChatPickPending } from "@/lib/chatPickPending";
import { isMessagesThreadSurface } from "@/lib/messagesTabBar";
import {
  getChatPushOffEdge,
  getChatPushOverlay,
  isChatPushExiting,
  repairChatPushSurface,
} from "@/lib/chatPushTransition";
import {
  chatSurfaceRouteParams,
  type ChatSurfaceRecord,
} from "@/lib/chatSurfaceRecordCore";
import { readChatSurface } from "@/lib/chatSurfaceRecord";
import { useSessionStore } from "@/stores/sessionStore";

/** Холодный старт: дать индексу/табам смонтироваться до пуша треда. */
const COLD_RESTORE_DELAY_MS = 160;
/**
 * Возврат из activity. Первая попытка — после кадра возврата; если пикер ещё
 * не отдал результат (`finally` не отработал), повторяем. Пикер возвращает
 * управление в том же кадре, когда отдаёт activity result, поэтому третий
 * заход нужен только на медленном устройстве.
 */
const RESUME_RECONCILE_DELAYS_MS = [120, 500, 1500] as const;

/**
 * Восстанавливает поверхность открытого чата после системных activity.
 *
 * Два независимых сценария, оба заканчиваются списком диалогов вместо чата:
 *
 *  1. **Процесс пережил пикер, но маршрут треда — нет.** Аварийное снятие
 *     оболочки (`router.back()` под пикером), выход из чата по ошибке запроса на
 *     возврате — навигация выполняется, пока activity в фоне, и пользователь
 *     возвращается в список. Лечится на возврате: ремонт поверхности, а если
 *     маршрута уже нет — переоткрытие по записи последнего чата.
 *  2. **Процесс выгружен, пока пикер был на экране.** JS-навигация смерть не
 *     переживает: холодный старт ставит приложение на ленту/список. Признак
 *     ровно один — уцелевшая метка пикера (`chatPickPending`), она пишется
 *     перед запуском галереи и снимается при возврате. Обычный перезапуск
 *     приложения метку не находит: пользователь остаётся там, куда пришёл.
 */
export function ChatSurfaceRestorer() {
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated);
  const segments = useSegments();
  const pathname = usePathname();
  const inThread = isMessagesThreadSurface({ segments, pathname });
  const inThreadRef = useRef(inThread);
  inThreadRef.current = inThread;
  /** Чат был открыт, когда приложение ушло в фон. */
  const wasInThreadAtBackgroundRef = useRef(false);
  /** Возврат из фона ждёт сверки: маршрут мог быть снят под activity. */
  const resumePendingRef = useRef(false);
  const coldRestoreCheckedRef = useRef(false);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const schedule = useCallback((run: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      run();
    }, delayMs);
    timersRef.current.add(timer);
  }, []);

  const openChat = useCallback((record: ChatSurfaceRecord) => {
    if (inThreadRef.current) return;
    if (__DEV__) {
      console.debug("[chat-surface] restore route", record.conversationUuid);
    }
    router.push({
      pathname: "/(tabs)/messages/[conversationUuid]",
      params: chatSurfaceRouteParams(record),
    });
  }, []);

  /**
   * Маршрут треда на месте — держим кадр/хиты. Маршрута нет, хотя чат был
   * открыт до ухода в фон, — возвращаем его по записи. Пикер впереди: решение
   * откладываем, его `finally` снимет флаг и сверка повторится.
   */
  const reconcile = useCallback(() => {
    if (isChatPickActivityActive()) return;
    if (inThreadRef.current) {
      resumePendingRef.current = false;
      if (getChatPushOverlay() != null && getChatPushOffEdge() && !isChatPushExiting()) {
        repairChatPushSurface();
      }
      return;
    }
    if (!resumePendingRef.current) return;
    resumePendingRef.current = false;
    const record = readChatSurface();
    if (record != null) openChat(record);
  }, [openChat]);

  // Холодный старт: JS-навигация не переживает смерть процесса. Возвращаем
  // последний открытый чат только по метке пикера — доказательству того, что
  // старт не добровольный.
  useEffect(() => {
    if (!isAuthenticated || coldRestoreCheckedRef.current) return;
    const path = pathname.replace(/\/$/, "");
    if (path === "" || path === "/") {
      // Индекс ещё редиректит; ждём целевой маршрут, чтобы не спорить.
      return;
    }
    coldRestoreCheckedRef.current = true;
    const pending = takeChatPickPending();
    if (pending == null) return;
    if (inThreadRef.current) return;
    const ordinaryLanding = path === "/feed" || path === "/messages";
    if (!ordinaryLanding) {
      // Пуш/диплинк ведёт в конкретный экран: не перебиваем.
      return;
    }
    const record = readChatSurface();
    if (record == null) return;
    if (
      record.conversationUuid.trim().toLowerCase() !==
      pending.conversationUuid.trim().toLowerCase()
    ) {
      return;
    }
    schedule(() => {
      if (inThreadRef.current) return;
      if (isChatPickActivityActive()) return;
      openChat(record);
    }, COLD_RESTORE_DELAY_MS);
  }, [inThread, isAuthenticated, openChat, pathname, schedule]);

  // Возврат из activity (пикер/камера/системный диалог).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        // Снимок «чат был открыт» до любых перерисовок возврата.
        wasInThreadAtBackgroundRef.current = inThreadRef.current;
        return;
      }
      const wasInThread = wasInThreadAtBackgroundRef.current;
      wasInThreadAtBackgroundRef.current = false;
      if (!wasInThread) return;
      resumePendingRef.current = true;
      // Повторы безвредны: сверка снимает флаг при первом же выполнении.
      for (const delay of RESUME_RECONCILE_DELAYS_MS) {
        schedule(reconcile, delay);
      }
    });
    return () => sub.remove();
  }, [reconcile, schedule]);

  useEffect(() => clearTimers, [clearTimers]);

  return null;
}
