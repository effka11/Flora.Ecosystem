import { parseNotification, type NotificationDto } from "@flora/client-core/contracts";
import type { NotificationRealtimeSignal } from "@flora/client-core/signals";
import type { QueryClient } from "@tanstack/react-query";

/** Экран держит `["notifications", category, search]`; сессионный observer — `["notifications", "all", ""]`. */
const NOTIFICATIONS_QUERY_PREFIX = ["notifications"] as const;

/**
 * Строка инбокса из SSE-сигнала. `app_update` — sideload-метаданные, в инбоксе такой
 * строки нет, поэтому вставлять её нельзя.
 */
export function notificationDtoFromSignal(
  signal: NotificationRealtimeSignal,
): NotificationDto | null {
  if (signal.type === "app_update") return null;
  return parseNotification({
    notificationUuid: signal.notificationUuid,
    type: signal.type,
    category: signal.category,
    text: signal.text,
    createdAt: signal.createdAt,
    isRead: false,
    postUuid: signal.postUuid,
    commentUuid: signal.commentUuid,
  });
}

function matchesCategorySlot(slot: unknown, category: NotificationDto["category"]): boolean {
  return slot === "all" || slot === category;
}

/**
 * Оптимистичная вставка новой строки в уже загруженные списки уведомлений.
 * Поиск ранжирует сервер — такие кэши не патчим, их догоняет coalesce-GET.
 */
export function insertNotificationIntoLists(
  queryClient: QueryClient,
  signal: NotificationRealtimeSignal,
): void {
  const dto = notificationDtoFromSignal(signal);
  if (!dto) return;
  const entries = queryClient.getQueriesData<NotificationDto[]>({
    queryKey: NOTIFICATIONS_QUERY_PREFIX,
  });
  for (const [queryKey, data] of entries) {
    if (!data) continue;
    if (queryKey[2] !== "") continue;
    if (!matchesCategorySlot(queryKey[1], dto.category)) continue;
    if (data.some((item) => item.notificationUuid === dto.notificationUuid)) continue;
    queryClient.setQueryData<NotificationDto[]>(queryKey, [dto, ...data]);
  }
}

/** Удаление строки из всех загруженных списков, включая поисковые. */
export function removeNotificationFromLists(
  queryClient: QueryClient,
  notificationUuid: string,
): void {
  if (!notificationUuid) return;
  queryClient.setQueriesData<NotificationDto[]>(
    { queryKey: NOTIFICATIONS_QUERY_PREFIX },
    (old) => {
      if (!old) return old;
      const next = old.filter((item) => item.notificationUuid !== notificationUuid);
      return next.length === old.length ? old : next;
    },
  );
}
