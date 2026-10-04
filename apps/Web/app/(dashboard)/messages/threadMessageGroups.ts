import type { MessageThreadItemDto } from "@/lib/socialApi";

export type ThreadRenderItem =
  | { kind: "own"; message: MessageThreadItemDto }
  | { kind: "peerGroup"; groupKey: string; messages: MessageThreadItemDto[] };

/**
 * Группировка ленты: peer-run по raw порядку (стабильный groupKey),
 * в DOM — только visible сообщения run'а.
 * Если у сообщений есть `senderUserUuid`, run режется по смене отправителя
 * (групповые чаты); без sender — как 1:1 (все подряд peer в одном run).
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
    const runSender = head.senderUserUuid?.trim() || null;
    const visibleInRun: MessageThreadItemDto[] = [];
    while (i < threadMessages.length && !threadMessages[i]!.isFromMe) {
      const m = threadMessages[i]!;
      const mSender = m.senderUserUuid?.trim() || null;
      if (runSender && mSender && mSender !== runSender) break;
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
