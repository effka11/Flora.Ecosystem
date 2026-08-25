/**
 * Прогрев раскладки текста на пути «палец → открытый чат», без сети:
 *
 *   - onPressIn (`warmChatOpenThreadAtPressIn`) — палец лёг на строку:
 *     дорасшифровать окно показа из кэша треда и поставить замеры текста;
 *     жест даёт ~100 мс форы до onPress.
 *   - onPress (`warmChatOpenTextLayoutAtTap`) — синхронные кэш-чтения (<1 мс):
 *     заявки в очередь offscreen-замера по уже расшифрованному.
 *   - ready треда (`warmThreadTextLayoutFromRows`) — добор строк, которые
 *     расшифровались уже после навигации.
 *
 * Хост замеров успевает отработать за время навигации (~100–200 мс до первого
 * кадра ленты), так что чат, до которого фоновый прогрев ещё не дошёл, тоже
 * открывается с финальной раскладкой.
 */
import type { MsgMessageDto } from "@flora/client-core/contracts";
import { isOptimisticPayloadSentinel } from "@/lib/messageBirthRegistry";
import {
  enqueueThreadTextMeasures,
  type WarmMeasureRow,
} from "@/lib/messageTextMeasureWarm";
import { getQueryClientRef } from "@/lib/queryClientRef";
import {
  messageDecryptCacheKey,
  warmThreadDecryptRows,
} from "@/lib/useThreadMessageDecrypt";
import { useFscpStore } from "@/stores/fscpStore";
import { messageThreadDecryptCache } from "@/stores/messageThreadCache";
import { useSessionStore } from "@/stores/sessionStore";

/** Ровно окно показа (THREAD_REVEAL_WINDOW): что попадёт в первый кадр. */
const TAP_WARM_ROWS = 16;

type ThreadPage = { items: MsgMessageDto[] };

type ChatOpenWarmTarget =
  | { kind: "dm"; conversationUuid: string; otherUserUuid: string }
  | { kind: "group"; conversationUuid: string };

export function warmChatOpenTextLayoutAtTap(args: ChatOpenWarmTarget): void {
  const queryClient = getQueryClientRef();
  if (!queryClient) return;
  const key =
    args.kind === "dm"
      ? ["messages", args.conversationUuid, args.otherUserUuid]
      : ["group-messages", args.conversationUuid];
  const items = queryClient.getQueryData<ThreadPage>(key)?.items;
  if (!items || items.length === 0) return;

  const rows: WarmMeasureRow[] = [];
  for (const m of items.slice(-TAP_WARM_ROWS)) {
    if (isOptimisticPayloadSentinel(m.encryptedPayload)) continue;
    const row = messageThreadDecryptCache.getMessage(messageDecryptCacheKey(m));
    if (!row || row.decryptState !== "ok") continue;
    rows.push({
      text: row.text,
      createdAt: row.createdAt,
      isFromMe: row.isFromMe,
      media: row.voiceBlock ? "voice" : row.imageBlocks.length > 0 ? "photo" : undefined,
    });
  }
  if (rows.length > 0) enqueueThreadTextMeasures(rows, { urgent: true });
}

/**
 * Прогрев треда с момента КАСАНИЯ строки (onPressIn): палец лежит на строке
 * ~80–120 мс до срабатывания onPress — Telegram использует это окно, чтобы
 * чат к моменту навигации был уже тёплым. Расшифровываем новейшее окно из
 * кэша треда (терминальные строки — бесплатный кэш-чек) и ставим замеры
 * текста. Сеть не трогаем; сорвавшийся тап (скролл) оставляет полезный
 * прогрев. Повторные вызовы дёшевы и идемпотентны.
 */
export function warmChatOpenThreadAtPressIn(args: ChatOpenWarmTarget): void {
  const queryClient = getQueryClientRef();
  if (!queryClient) return;
  const key =
    args.kind === "dm"
      ? ["messages", args.conversationUuid, args.otherUserUuid]
      : ["group-messages", args.conversationUuid];
  const items = queryClient.getQueryData<ThreadPage>(key)?.items;
  if (!items || items.length === 0) {
    if (__DEV__) {
      // Нечего греть = сетевой фетч на открытии (симптом: data>1000мс в трассе).
      console.log("[chat-warm] press-in: сообщений в кэше нет — открытие пойдёт через сеть");
    }
    return;
  }

  // Уже расшифрованные строки — в замер сразу, не дожидаясь дорасшифровки:
  // каждый выигранный кадр хоста уменьшает шанс двухпроходного замера в ячейке.
  warmChatOpenTextLayoutAtTap(args);

  const fscp = useFscpStore.getState();
  const viewerUserUuid = useSessionStore.getState().me?.userUuid?.trim() ?? "";
  if (!fscp.material || !fscp.canDecrypt() || !viewerUserUuid) {
    if (__DEV__) console.log("[chat-warm] press-in: FSCP не готов — дорасшифровка недоступна");
    return;
  }

  void warmThreadDecryptRows({
    conversationUuid: args.conversationUuid,
    messages: items.slice(-TAP_WARM_ROWS),
    isGroupChat: args.kind === "group",
    viewerUserUuid,
    decryptWirePlaintext: (wire, viewer) =>
      useFscpStore.getState().decryptWirePlaintext(wire, viewer),
    // Микрозадачный yield вместо setTimeout: окно ≤16 строк, тап уже летит.
    // Каждая расшифровка сама уступает поток на переходе через мост.
    yieldBetweenSteps: () => Promise.resolve(),
  })
    .then(() => warmChatOpenTextLayoutAtTap(args))
    .catch(() => undefined);
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
  const warm: WarmMeasureRow[] = [];
  for (const row of rows.slice(-TAP_WARM_ROWS)) {
    if (row.decryptState !== "ok") continue;
    if (row.text.trim().length === 0) continue;
    warm.push({
      text: row.text,
      createdAt: row.createdAt,
      isFromMe: row.isFromMe,
      media: row.voiceBlock ? "voice" : row.imageBlocks.length > 0 ? "photo" : undefined,
    });
  }
  if (warm.length > 0) enqueueThreadTextMeasures(warm, { urgent: true });
}
