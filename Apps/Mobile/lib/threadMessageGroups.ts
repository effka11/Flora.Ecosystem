import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";

export type ThreadListItem =
  | { kind: "own"; message: ThreadBubbleItem }
  | { kind: "peerGroup"; groupKey: string; messages: ThreadBubbleItem[] };

/**
 * Группировка ленты: peer-run по raw порядку (стабильный groupKey),
 * в item — только visible сообщения run'а. Как Web threadMessageGroups.
 */
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
    const visibleInRun: ThreadBubbleItem[] = [];
    while (i < threadMessages.length && !threadMessages[i]!.isFromMe) {
      const m = threadMessages[i]!;
      if (isVisible(m)) visibleInRun.push(m);
      i += 1;
    }
    if (visibleInRun.length > 0) {
      items.push({ kind: "peerGroup", groupKey, messages: visibleInRun });
    }
  }
  return items;
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

/** Плоский обход list items (после reverse — тоже ок). */
export function forEachThreadListMessage(
  items: readonly ThreadListItem[],
  fn: (message: ThreadBubbleItem) => void,
): void {
  for (const item of items) {
    if (item.kind === "own") {
      fn(item.message);
      continue;
    }
    for (const message of item.messages) {
      fn(message);
    }
  }
}
