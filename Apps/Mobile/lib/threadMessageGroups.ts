import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";

/**
 * Плоская модель ленты (телеграмная): каждый пузырь — отдельный item
 * FlashList, включая peer-сообщения. Раньше peer-run был одним item'ом
 * (`peerGroup` с массивом сообщений) — FlashList не мог виртуализовать
 * внутри группы, и чат из длинных run'ов монтировал десятки пузырей одним
 * коммитом (сотни мс до первого кадра). Группировка осталась визуальной:
 * `groupKey` объединяет run, `isGroupTail` отмечает новейшее visible
 * сообщение run'а — строку с аватаром (лента перевёрнута, хвост внизу).
 */
export type ThreadListItem =
  | { kind: "own"; message: ThreadBubbleItem }
  | {
      kind: "peer";
      message: ThreadBubbleItem;
      /** Стабильный ключ run'а — uuid головы run'а по raw-порядку. */
      groupKey: string;
      /** Новейшее visible сообщение run'а — строка носит аватар. */
      isGroupTail: boolean;
    };

/**
 * Peer-run режется при смене `senderUserUuid` (нормализованный ключ; пустой —
 * отдельный бакет). DM без uuid остаются одним run; битый group DTO с дыркой
 * sender не склеивает разных авторов. Как Web threadMessageGroups.
 */
function peerSenderKey(message: ThreadBubbleItem): string {
  return message.senderUserUuid?.trim().toLowerCase() ?? "";
}

export function buildThreadListItems(
  threadMessages: readonly ThreadBubbleItem[],
  isVisible: (message: ThreadBubbleItem) => boolean,
): ThreadListItem[] {
  const items: ThreadListItem[] = [];
  let i = 0;
  while (i < threadMessages.length) {
    const head = threadMessages[i]!;
    if (head.isFromMe) {
      if (isVisible(head)) {
        items.push({ kind: "own", message: head });
      }
      i += 1;
      continue;
    }

    const groupKey = head.messageUuid;
    const runSender = peerSenderKey(head);
    const visibleInRun: ThreadBubbleItem[] = [];
    while (i < threadMessages.length && !threadMessages[i]!.isFromMe) {
      const m = threadMessages[i]!;
      if (peerSenderKey(m) !== runSender) break;
      if (isVisible(m)) visibleInRun.push(m);
      i += 1;
    }
    for (let k = 0; k < visibleInRun.length; k++) {
      items.push({
        kind: "peer",
        message: visibleInRun[k]!,
        groupKey,
        isGroupTail: k === visibleInRun.length - 1,
      });
    }
  }
  return items;
}

function threadListItemReusable(prev: ThreadListItem, next: ThreadListItem): boolean {
  if (prev.kind !== next.kind || prev.message !== next.message) return false;
  if (prev.kind === "peer" && next.kind === "peer") {
    return prev.groupKey === next.groupKey && prev.isGroupTail === next.isGroupTail;
  }
  return true;
}

/**
 * Переиспользование item-объектов между пересборками ленты. Ячейки FlashList
 * мемоизированы по item: без этого каждый setRows (волна дорасшифровки, merge
 * меты) выдавал НОВЫЕ обёртки для всех строк — и весь вьюпорт ре-рендерился,
 * хотя строки не менялись (симптом: cells=52 при окне 13 в трассе открытия).
 * Совпало всё — возвращается прежний массив по ссылке: memo выше не дёргается.
 */
export function reuseThreadListItems(
  prev: readonly ThreadListItem[],
  next: ThreadListItem[],
): readonly ThreadListItem[] {
  if (prev.length === 0) return next;
  const prevByUuid = new Map<string, ThreadListItem>();
  for (const item of prev) prevByUuid.set(item.message.messageUuid, item);

  let allReused = prev.length === next.length;
  for (let i = 0; i < next.length; i++) {
    const candidate = prevByUuid.get(next[i]!.message.messageUuid);
    if (candidate && threadListItemReusable(candidate, next[i]!)) {
      if (candidate !== prev[i]) allReused = false;
      next[i] = candidate;
    } else {
      allReused = false;
    }
  }
  return allReused ? prev : next;
}

/**
 * Hold аватара хвоста только если группа уже была на экране (есть visible,
 * не из текущего insert-batch). Если все пузыри группы новые — аватар
 * появляется вместе с сообщением и едет в insertLift без контр-transform.
 */
export function shouldHoldTrailingPeerAvatar(
  trailingPeerMessages: readonly { messageUuid: string }[],
  newlyVisibleUuids: ReadonlySet<string>,
): boolean {
  if (trailingPeerMessages.length === 0) return false;
  return trailingPeerMessages.some((m) => !newlyVisibleUuids.has(m.messageUuid));
}

/**
 * Сообщения хвостового peer-run'а (лента newest-first: run — префикс списка
 * с одним groupKey). Для решения о hold аватара при insertLift.
 */
export function trailingPeerRunMessages(
  itemsNewestFirst: readonly ThreadListItem[],
): ThreadBubbleItem[] {
  const head = itemsNewestFirst[0];
  if (head == null || head.kind !== "peer") return [];
  const run: ThreadBubbleItem[] = [];
  for (const item of itemsNewestFirst) {
    if (item.kind !== "peer" || item.groupKey !== head.groupKey) break;
    run.push(item.message);
  }
  return run;
}

/** Плоский обход list items (после reverse — тоже ок). */
export function forEachThreadListMessage(
  items: readonly ThreadListItem[],
  fn: (message: ThreadBubbleItem) => void,
): void {
  for (const item of items) {
    fn(item.message);
  }
}
