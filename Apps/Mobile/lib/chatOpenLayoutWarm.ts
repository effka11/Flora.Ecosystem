/**
 * Прогрев раскладки текста в момент тапа по чату — синхронно и без сети:
 * только чтение уже расшифрованных строк из decrypt-кэша и заявки в очередь
 * offscreen-замера. Хост замеров успевает отработать за время навигации
 * (~100–200 мс до первого кадра ленты), так что чат, до которого фоновый
 * прогрев ещё не дошёл, тоже открывается с финальной раскладкой.
 *
 * Ничего не расшифровываем и не качаем: тап — самое горячее место JS-потока,
 * здесь позволительны только дешёвые кэш-чтения (<1 мс).
 */
import type { MsgMessageDto } from "@flora/client-core/contracts";
import { isOptimisticPayloadSentinel } from "@/lib/messageBirthRegistry";
import { enqueueThreadTextMeasures } from "@/lib/messageTextMeasureWarm";
import { getQueryClientRef } from "@/lib/queryClientRef";
import { messageDecryptCacheKey } from "@/lib/useThreadMessageDecrypt";
import { messageThreadDecryptCache } from "@/stores/messageThreadCache";

/** Ровно окно показа (THREAD_REVEAL_WINDOW): что попадёт в первый кадр. */
const TAP_WARM_ROWS = 16;

type ThreadPage = { items: MsgMessageDto[] };

export function warmChatOpenTextLayoutAtTap(
  args:
    | { kind: "dm"; conversationUuid: string; otherUserUuid: string }
    | { kind: "group"; conversationUuid: string },
): void {
  const queryClient = getQueryClientRef();
  if (!queryClient) return;
  const key =
    args.kind === "dm"
      ? ["messages", args.conversationUuid, args.otherUserUuid]
      : ["group-messages", args.conversationUuid];
  const items = queryClient.getQueryData<ThreadPage>(key)?.items;
  if (!items || items.length === 0) return;

  const rows: { text: string; createdAt: string; isFromMe: boolean }[] = [];
  for (const m of items.slice(-TAP_WARM_ROWS)) {
    if (isOptimisticPayloadSentinel(m.encryptedPayload)) continue;
    const row = messageThreadDecryptCache.getMessage(messageDecryptCacheKey(m));
    if (!row || row.decryptState !== "ok") continue;
    if (row.voiceBlock || row.imageBlocks.length > 0) continue;
    rows.push({ text: row.text, createdAt: row.createdAt, isFromMe: row.isFromMe });
  }
  if (rows.length > 0) enqueueThreadTextMeasures(rows);
}

/** Строка треда, достаточная для прогрева (структурно — ThreadBubbleItem). */
type WarmableThreadRow = {
  decryptState: string;
  text: string;
  createdAt: string;
  isFromMe: boolean;
  voiceBlock?: unknown;
  imageBlocks: readonly unknown[];
};

/**
 * Прогрев замеров по уже расшифрованным строкам — вызывается на `ready` треда.
 * Тап-прогрев выше покрывает только строки, расшифрованные ДО тапа; холодный
 * тред (фоновый прогрев не дошёл — обычное дело при быстром хождении по
 * чатам) расшифровывается уже после навигации. Без этого вызова первые замеры
 * шли бы двухпроходно прямо в ячейках — коррекции высот в самом горячем окне
 * открытия (симптом: `layout-прогрет=1/10` в трассе).
 */
export function warmThreadTextLayoutFromRows(rows: readonly WarmableThreadRow[]): void {
  const warm: { text: string; createdAt: string; isFromMe: boolean }[] = [];
  for (const row of rows.slice(-TAP_WARM_ROWS)) {
    if (row.decryptState !== "ok") continue;
    if (row.voiceBlock || row.imageBlocks.length > 0) continue;
    if (row.text.trim().length === 0) continue;
    warm.push({ text: row.text, createdAt: row.createdAt, isFromMe: row.isFromMe });
  }
  if (warm.length > 0) enqueueThreadTextMeasures(warm);
}
