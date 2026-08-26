/**
 * Прогрев на пути «палец → открытый чат»:
 *
 *   - onPressIn (`warmChatOpenThreadAtPressIn`) — палец лёг на строку:
 *     дорасшифровать окно показа из кэша треда и поставить замеры текста;
 *     жест даёт ~100 мс форы до onPress. Тред без кэша (фоновый прогрев не
 *     дошёл) тем же касанием запрашивает первую страницу из сети.
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
  fetchThreadFirstPage,
  threadFirstPageQueryKey,
  THREAD_FIRST_PAGE_STALE_MS,
  type ThreadFirstPageTarget,
} from "@/lib/threadFirstPage";
import {
  messageDecryptCacheKey,
  warmThreadDecryptRows,
} from "@/lib/useThreadMessageDecrypt";
import { useFscpStore } from "@/stores/fscpStore";
import { messageThreadDecryptCache } from "@/stores/messageThreadCache";
import { useSessionStore } from "@/stores/sessionStore";

/** Ровно окно показа (THREAD_REVEAL_WINDOW): что попадёт в первый кадр. */
const TAP_WARM_ROWS = 16;

/**
 * Пауза между сетевыми доборами по касанию. onPressIn прилетает и на касаниях,
 * которые станут скроллом, поэтому запрос по касанию — редкое событие: только
 * для треда без кэша, по одному в полёте и не чаще этой паузы. Быстрый скролл
 * мимо холодных строк успевает выпустить один-два запроса, а не двадцать.
 */
const PRESS_IN_FETCH_COOLDOWN_MS = 500;

type ThreadPage = { items: MsgMessageDto[] };

type ChatOpenWarmTarget = ThreadFirstPageTarget;

let pressInFetchInFlight = false;
let pressInFetchStartedAt = 0;

/**
 * Тред без кэша = открытие через сеть уже после монтирования экрана (симптом:
 * `data>1000мс` в трассе). Запрос по касанию отдаёт открытию форы на время
 * жеста и навигации: ключ и фетч те же, что у `useQuery` экрана, поэтому
 * экран подхватит этот же полёт вместо второго запроса.
 */
function prefetchColdThreadAtPressIn(target: ChatOpenWarmTarget): void {
  const queryClient = getQueryClientRef();
  if (!queryClient) return;
  if (target.kind === "dm" && !target.otherUserUuid.trim()) return;
  if (pressInFetchInFlight) return;
  if (Date.now() - pressInFetchStartedAt < PRESS_IN_FETCH_COOLDOWN_MS) return;

  pressInFetchInFlight = true;
  pressInFetchStartedAt = Date.now();
  const startedAt = pressInFetchStartedAt;
  void queryClient
    .prefetchQuery({
      queryKey: threadFirstPageQueryKey(target),
      queryFn: () => fetchThreadFirstPage(target),
      staleTime: THREAD_FIRST_PAGE_STALE_MS,
    })
    .then(() => {
      if (__DEV__) {
        console.log(
          `[chat-warm] press-in: страница треда доехала за ${Date.now() - startedAt}мс`,
        );
      }
      // Страница приехала — досюда путь тот же, что у тёплого треда:
      // расшифровка окна показа и замеры. Экран мог уже смонтироваться, это
      // те же кэши, которые он читает, а вызов идемпотентен.
      warmChatOpenThreadAtPressIn(target);
    })
    .catch(() => undefined)
    .finally(() => {
      pressInFetchInFlight = false;
    });
}

export function warmChatOpenTextLayoutAtTap(args: ChatOpenWarmTarget): void {
  const queryClient = getQueryClientRef();
  if (!queryClient) return;
  const items = queryClient.getQueryData<ThreadPage>(threadFirstPageQueryKey(args))?.items;
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
 * текста. Сеть — только для треда без кэша (см. `prefetchColdThreadAtPressIn`);
 * сорвавшийся тап (скролл) оставляет полезный прогрев. Повторные вызовы дёшевы
 * и идемпотентны.
 */
export function warmChatOpenThreadAtPressIn(args: ChatOpenWarmTarget): void {
  const queryClient = getQueryClientRef();
  if (!queryClient) return;
  const items = queryClient.getQueryData<ThreadPage>(threadFirstPageQueryKey(args))?.items;
  if (!items || items.length === 0) {
    if (__DEV__) console.log("[chat-warm] press-in: кэша нет — запрашиваем страницу треда");
    prefetchColdThreadAtPressIn(args);
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
