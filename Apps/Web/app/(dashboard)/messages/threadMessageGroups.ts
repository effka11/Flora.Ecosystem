import type { MessageThreadItemDto } from "@/lib/socialApi";

export type ThreadRenderItem =
  | { kind: "own"; message: MessageThreadItemDto }
  | { kind: "peerGroup"; groupKey: string; messages: MessageThreadItemDto[] };

/**
 * Группировка ленты: peer-run по raw порядку (стабильный groupKey),
 * в DOM — только visible сообщения run'а.
 */
export function buildThreadRenderItems(
  threadMessages: readonly MessageThreadItemDto[],
  isVisible: (message: MessageThreadItemDto) => boolean,
): ThreadRenderItem[] {
  const items: ThreadRenderItem[] = [];
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
    const visibleInRun: MessageThreadItemDto[] = [];
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
