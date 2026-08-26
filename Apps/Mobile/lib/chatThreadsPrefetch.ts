/**
 * Тихий прогрев переписок (Telegram-tier): после успеха `["conversations"]`/
 * `["groups"]` в idle-паузы скролла последовательно
 *
 *   1. аватары верхних строк списка — в FRC-кэш (avatar lane, диск);
 *   2. расшифровываются превью видимого экрана списка чатов;
 *   3. лёгкая фаза топ-N тредов: decrypt-прогрев кэша (мгновенное открытие
 *      офлайн/с диска), при устаревании — сетевой prefetch первой страницы,
 *      группам roster (`["group", uuid]`), затем offscreen-замер раскладки;
 *   4. CPU-прогрев раскладки чатов за пределами топа (без сети);
 *   5. тяжёлая фаза: вложения новейших сообщений (фото `.fri` →
 *      детерминированный PNG + aspect ratio, голосовые → расшифрованный файл)
 *      и аватары участников групп — под бюджетом прохода. Медиа в самом
 *      конце намеренно: вложения одного чата не должны задерживать
 *      расшифровку остальных.
 *
 * Реагирует на изменения списка (realtime/FCM-патчи уже пишут в
 * `["conversations"]`), поэтому новое сообщение в закрытом чате тихо
 * подтягивает тред ещё до его открытия. Открытый тред исключён — он
 * обновляет себя сам через `subscribeMessageRealtime`.
 *
 * Работает только через существующие кэши экранов: RQ-ключи и запись в
 * `messageThreadCache`/`messageThreadDecryptCache`/`messagePreviewCache`,
 * `uriCache` картинок/голосовых и ratio-store идентичны путям открытия чата.
 */

import { apiGetGroup } from "@flora/client-core/api";
import type {
  MsgConversationDto,
  MsgConversationsPage,
  MsgGroupDetail,
  MsgGroupListItem,
  MsgMessageDto,
} from "@flora/client-core/contracts";
import { avatarImageUrl } from "@flora/client-core/display";
import { isFscpWirePayload, type FscpImageBlock } from "@flora/client-core/fscp";
import type { QueryClient } from "@tanstack/react-query";
import { Image } from "react-native";
import {
  getActiveMessageThread,
  subscribeActiveMessageThread,
} from "@/lib/activeMessageThread";
import {
  createThreadMediaWarmBudget,
  selectThreadMediaWarmTargets,
  selectThreadPrefetchCandidates,
  type ThreadFreshnessProbe,
  type ThreadMediaRow,
  type ThreadMediaWarmBudget,
  type ThreadPrefetchCandidate,
} from "@/lib/chatPrefetchPolicy";
import { prefetchFrcImage } from "@/lib/frcImage";
import { mapIdleSliced, yieldToEventLoop, type IdleSlicedHandle } from "@/lib/idleScrollGate";
import { getStoredImageRatio, rememberImageRatio } from "@/lib/imageRatioStore";
import { isOptimisticPayloadSentinel } from "@/lib/messageBirthRegistry";
import { ensureMessageImageUri } from "@/lib/messageImageAssets";
import {
  enqueueThreadTextMeasures,
  type WarmMeasureRow,
} from "@/lib/messageTextMeasureWarm";
import { ensureMessageVoiceUri } from "@/lib/messageVoiceAssets";
import { floraSpacing } from "@/lib/theme";
import {
  fetchThreadFirstPage,
  threadFirstPageQueryKey,
  type ThreadFirstPageTarget,
} from "@/lib/threadFirstPage";
import {
  messageDecryptCacheKey,
  warmThreadDecryptRows,
} from "@/lib/useThreadMessageDecrypt";
import { useFscpStore } from "@/stores/fscpStore";
import { messagePreviewCache, messagePreviewKey } from "@/stores/messagePreviewCache";
import { messageThreadDecryptCache } from "@/stores/messageThreadCache";
import { useSessionStore } from "@/stores/sessionStore";

const EVALUATE_DEBOUNCE_MS = 400;
/** Перепроверка, пока открыт тред: прогрев чужих чатов ждёт выхода из него. */
const THREAD_OPEN_RECHECK_MS = 3000;
/** Возобновление сразу после выхода из треда (небольшая пауза на осадку списка). */
const THREAD_CLOSE_RESUME_MS = 300;
const THREAD_PREFETCH_STALE_MS = 15_000;
const GROUP_DETAIL_PREFETCH_STALE_MS = 30_000;
/**
 * Размер аватара строк списка чатов и peer-пузырей треда (AVATAR_SIZE =
 * peerBubbleAvatarSize = 3×grid): прогрев в тот же bucket FRC-кэша, что
 * запросят строки, — иначе exact-hit не случится.
 */
const AVATAR_WARM_PX = floraSpacing.grid * 3;
/** Сколько верхних строк списка греть аватарами (примерно два экрана). */
const AVATAR_WARM_MAX_ROWS = 30;
/** Аватары участников группы (peer-пузыри) — только верхушка ростера. */
const GROUP_AVATAR_WARM_MAX = 8;
/**
 * Сколько новейших сообщений треда отдать в offscreen-замер раскладки: это
 * ровно окно показа (`THREAD_REVEAL_WINDOW`) — то, что попадёт в первый кадр
 * ленты и обязано встать на место без перескока.
 */
const TEXT_MEASURE_WARM_ROWS = 16;
/** Превью первой фазы — примерно один видимый экран списка чатов. */
const PREVIEW_FIRST_SCREEN_ROWS = 10;
/**
 * Потолок CPU-фазы прогрева раскладки за пределами топ-кандидатов: тап
 * приходит и в чат глубже списка — его первый кадр обязан быть таким же
 * тёплым. Сети в фазе нет: только расшифровка новейшего окна из кэша треда
 * и заявки на offscreen-замер текста.
 */
const LAYOUT_WARM_MAX_THREADS = 40;

type ThreadPage = { items: MsgMessageDto[]; nextCursor: string | null };

/** Кандидат → цель фетча: ключ и запрос общие с экраном треда и press-in. */
function threadTarget(candidate: ThreadPrefetchCandidate): ThreadFirstPageTarget {
  return candidate.kind === "dm"
    ? {
        kind: "dm",
        conversationUuid: candidate.conversationUuid,
        otherUserUuid: candidate.otherUserUuid,
      }
    : { kind: "group", conversationUuid: candidate.conversationUuid };
}

function threadQueryKey(candidate: ThreadPrefetchCandidate): readonly unknown[] {
  return threadFirstPageQueryKey(threadTarget(candidate));
}

function probeThread(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): ThreadFreshnessProbe | null {
  const state = queryClient.getQueryState<ThreadPage>(queryKey);
  if (!state) return null;
  const items = state.data?.items;
  return {
    hasData: state.status === "success" && !!state.data,
    newestCreatedAt: items && items.length > 0 ? items[items.length - 1]!.createdAt : null,
    dataUpdatedAt: state.dataUpdatedAt,
    isInvalidated: state.isInvalidated,
    isFetching: state.fetchStatus === "fetching",
  };
}

/**
 * Зеркало decryptOne из `useMessagesListPreviewDecrypt`, но без кэширования
 * плейсхолдеров: null от decryptPreview (ключи заблокировались) — просто скип.
 */
async function warmOneListPreview(
  item: MsgConversationDto,
  viewerUserUuid: string,
): Promise<void> {
  const mk = messagePreviewKey(item.lastMessageEncryptedForMe, item.lastMessageAt);
  const cached = messagePreviewCache.get(item.conversationUuid);
  if (cached && cached.msgKey === mk) return;

  let text: string;
  if (item.lastMessageContent?.trim()) {
    text = item.lastMessageContent;
  } else {
    const enc = item.lastMessageEncryptedForMe?.trim();
    if (!enc) {
      text = "Нет сообщений";
    } else if (!isFscpWirePayload(enc)) {
      text = enc;
    } else {
      const preview = await useFscpStore.getState().decryptPreview(enc, viewerUserUuid);
      if (preview == null) return;
      text = preview;
    }
  }
  messagePreviewCache.set(item.conversationUuid, mk, text);
}

export function startChatThreadsPrefetch(queryClient: QueryClient): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeSlice: IdleSlicedHandle<unknown> | null = null;
  let runInFlight = false;
  let rerunRequested = false;
  /** Cancel-функции фоновых prefetchFrcImage — вызвать при stop() (logout). */
  let avatarPrefetchCancels: (() => void)[] = [];

  const decryptWirePlaintext = (wire: string, viewerUserUuid: string) =>
    useFscpStore.getState().decryptWirePlaintext(wire, viewerUserUuid);

  /**
   * Аватар в FRC-кэш (диск, MMKV-индекс): exact-hit при повторном вызове —
   * no-op, так что дедупликация между проходами бесплатна.
   */
  const prefetchAvatar = (avatarUuid: string | null | undefined): void => {
    const id = avatarUuid?.trim();
    if (!id || stopped) return;
    avatarPrefetchCancels.push(
      prefetchFrcImage(avatarImageUrl(id), {
        displayWidth: AVATAR_WARM_PX,
        lane: "avatar",
      }),
    );
  };

  const warmThreadFromCache = async (
    candidate: ThreadPrefetchCandidate,
    viewerUserUuid: string,
  ): Promise<void> => {
    const items = queryClient.getQueryData<ThreadPage>(threadQueryKey(candidate))?.items;
    if (!items || items.length === 0) return;
    await warmThreadDecryptRows({
      conversationUuid: candidate.conversationUuid,
      messages: items,
      isGroupChat: candidate.kind === "group",
      viewerUserUuid,
      decryptWirePlaintext,
      shouldContinue: () => !stopped,
    });
  };

  /**
   * Скачать+расшифровать+декодировать `.fri` в детерминированный PNG и
   * запомнить aspect ratio (MMKV): одиночное фото при открытии резервирует
   * точную высоту и рисуется с первого кадра — без «Загрузка…» и прыжка.
   */
  const warmMessageImage = async (block: FscpImageBlock): Promise<void> => {
    try {
      const uri = await ensureMessageImageUri(block);
      if (getStoredImageRatio(block.assetUuid) == null) {
        Image.getSize(
          uri,
          (w, h) => {
            if (w > 0 && h > 0) rememberImageRatio(block.assetUuid, w / h);
          },
          () => undefined,
        );
      }
    } catch {
      // Прогрев молчалив: пузырь при открытии повторит попытку сам.
    }
  };

  /**
   * Раскладка текста новейших сообщений — в кэш замеров до открытия чата
   * (Flora-аналог generateLayout из Telegram). Без этого пузырь при открытии
   * рисуется однострочным, а после onTextLayout перескакивает в реальную
   * раскладку — визуально «допрыгивает» на место.
   */
  const warmCandidateTextLayout = (candidate: ThreadPrefetchCandidate): void => {
    const items = queryClient.getQueryData<ThreadPage>(threadQueryKey(candidate))?.items;
    if (!items || items.length === 0) return;
    const newest = items.slice(-TEXT_MEASURE_WARM_ROWS);
    const rows: WarmMeasureRow[] = [];
    for (const m of newest) {
      if (isOptimisticPayloadSentinel(m.encryptedPayload)) continue;
      const row = messageThreadDecryptCache.getMessage(messageDecryptCacheKey(m));
      if (!row || row.decryptState !== "ok") continue;
      rows.push({
        text: row.text,
        createdAt: row.createdAt,
        isFromMe: row.isFromMe,
        // Подписи медиа тоже греем: их колонка уже, и без замера длинная
        // подпись рисуется выше финала, а после домера видимо схлопывается.
        media: row.voiceBlock ? "voice" : row.imageBlocks.length > 0 ? "photo" : undefined,
      });
    }
    if (rows.length > 0) enqueueThreadTextMeasures(rows);
  };

  /**
   * Лёгкий прогрев раскладки без сети: расшифровка новейшего окна из кэша
   * треда + заявки на offscreen-замер текста. Для чатов за пределами
   * топ-кандидатов (`selectThreadPrefetchCandidates` берёт 8 DM + 4 группы):
   * без этой фазы тап в чат №15 монтировал пузыри с непрогретой раскладкой —
   * дольше открытие и перескок строк при домере.
   */
  const warmThreadLayoutFromCache = async (
    candidate: ThreadPrefetchCandidate,
    viewerUserUuid: string,
  ): Promise<void> => {
    const items = queryClient.getQueryData<ThreadPage>(threadQueryKey(candidate))?.items;
    if (!items || items.length === 0) return;
    await warmThreadDecryptRows({
      conversationUuid: candidate.conversationUuid,
      messages: items.slice(-TEXT_MEASURE_WARM_ROWS),
      isGroupChat: candidate.kind === "group",
      viewerUserUuid,
      decryptWirePlaintext,
      shouldContinue: () => !stopped && getActiveMessageThread() == null,
    });
    warmCandidateTextLayout(candidate);
  };

  /** Вложения новейших сообщений треда — по строкам decrypt-кэша. */
  const warmCandidateMedia = async (
    candidate: ThreadPrefetchCandidate,
    budget: ThreadMediaWarmBudget,
  ): Promise<void> => {
    if (budget.images <= 0 && budget.voices <= 0) return;
    const items = queryClient.getQueryData<ThreadPage>(threadQueryKey(candidate))?.items;
    if (!items || items.length === 0) return;
    const rows: ThreadMediaRow[] = [];
    for (const m of items) {
      if (isOptimisticPayloadSentinel(m.encryptedPayload)) continue;
      const row = messageThreadDecryptCache.getMessage(messageDecryptCacheKey(m));
      if (row && row.decryptState === "ok") rows.push(row);
    }
    const targets = selectThreadMediaWarmTargets(rows, budget);
    for (const block of targets.images) {
      if (stopped) return;
      await warmMessageImage(block);
      await yieldToEventLoop();
    }
    for (const block of targets.voices) {
      if (stopped) return;
      await ensureMessageVoiceUri(block).catch(() => undefined);
      await yieldToEventLoop();
    }
  };

  /**
   * Лёгкая фаза кандидата: кэш → сеть → расшифровка → замеры раскладки.
   * Медиа здесь нет намеренно: тяжёлый прогрев вложений первого кандидата
   * (скачивание+декод `.fri`) блокировал расшифровку остальных на секунды —
   * тап в чат №3 спустя 5 секунд от старта попадал в холодный тред.
   */
  const processCandidateThread = async (
    candidate: ThreadPrefetchCandidate,
    viewerUserUuid: string,
    canDecrypt: boolean,
  ): Promise<void> => {
    if (stopped) return;
    // Сначала прогрев того, что уже есть (диск/память): мгновенное открытие
    // даже офлайн, до любых сетевых попыток.
    if (canDecrypt) await warmThreadFromCache(candidate, viewerUserUuid);

    if (candidate.needsMessages && !stopped) {
      const target = threadTarget(candidate);
      await queryClient.prefetchQuery({
        queryKey: threadFirstPageQueryKey(target),
        queryFn: () => fetchThreadFirstPage(target),
        // Короче, чем staleTime экрана: фоновый прогрев обновляет тред охотнее,
        // чем открытие, которому свежести кэша достаточно.
        staleTime: THREAD_PREFETCH_STALE_MS,
      });
      if (canDecrypt && !stopped) await warmThreadFromCache(candidate, viewerUserUuid);
    }

    if (candidate.kind === "group" && candidate.needsDetail && !stopped) {
      await queryClient.prefetchQuery({
        queryKey: ["group", candidate.conversationUuid],
        queryFn: () => apiGetGroup(candidate.conversationUuid),
        staleTime: GROUP_DETAIL_PREFETCH_STALE_MS,
        retry: false,
      });
    }

    if (canDecrypt && !stopped) warmCandidateTextLayout(candidate);
  };

  /** Тяжёлая фаза кандидата: вложения сообщений и аватары участников группы. */
  const processCandidateMedia = async (
    candidate: ThreadPrefetchCandidate,
    canDecrypt: boolean,
    mediaBudget: ThreadMediaWarmBudget,
  ): Promise<void> => {
    if (stopped) return;
    if (candidate.kind === "group") {
      const detail = queryClient.getQueryData<MsgGroupDetail>([
        "group",
        candidate.conversationUuid,
      ]);
      for (const member of (detail?.members ?? []).slice(0, GROUP_AVATAR_WARM_MAX)) {
        prefetchAvatar(member.avatarUuid);
      }
    }
    if (canDecrypt && !stopped) await warmCandidateMedia(candidate, mediaBudget);
  };

  const run = async (): Promise<void> => {
    // Открыт тред — JS-поток принадлежит ему (открытие + чтение). Фоновый
    // прогрев чужих чатов переносится и сам возобновится после выхода.
    if (getActiveMessageThread() != null) {
      schedule(THREAD_OPEN_RECHECK_MS);
      return;
    }
    const viewerUserUuid = useSessionStore.getState().me?.userUuid?.trim() ?? "";
    if (!viewerUserUuid || stopped) return;
    const fscp = useFscpStore.getState();
    const canDecrypt = Boolean(fscp.material) && fscp.canDecrypt();

    const conversations =
      queryClient.getQueryData<MsgConversationsPage>(["conversations"])?.items ?? [];
    const groups = queryClient.getQueryData<MsgGroupListItem[]>(["groups"]) ?? [];
    if (conversations.length === 0 && groups.length === 0) return;

    // Прошлые подписки давно доехали (background lane), держать их незачем.
    avatarPrefetchCancels = [];
    // Аватары верхних строк списка: пайплайн сам дедуплицирует и уступает
    // видимым декодам, здесь только регистрация подписок.
    for (const item of conversations.slice(0, AVATAR_WARM_MAX_ROWS)) {
      prefetchAvatar(item.otherAvatarUuid);
    }

    const warmPreviews = async (items: readonly MsgConversationDto[]): Promise<boolean> => {
      if (!canDecrypt || items.length === 0) return true;
      const previews = mapIdleSliced(items, (item) => {
        // Тред открылся посреди прогона — остаток работы отменяем дёшево,
        // rerunRequested доведёт прогон после выхода из треда.
        if (getActiveMessageThread() != null) {
          rerunRequested = true;
          return Promise.resolve(undefined);
        }
        return warmOneListPreview(item, viewerUserUuid);
      });
      activeSlice = previews;
      await previews.done;
      activeSlice = null;
      return !stopped;
    };

    // Превью — двумя фазами: сначала видимый экран списка, потом (после
    // прогрева тредов) хвост. Раньше расшифровывались превью ВСЕХ чатов до
    // прогрева тредов, а превью — это асимметричный decrypt на чат: при
    // длинном списке тред-прогрев начинался спустя секунды, и тап почти сразу
    // после запуска попадал в холодный чат — «прогрев уже после нажатия».
    if (!(await warmPreviews(conversations.slice(0, PREVIEW_FIRST_SCREEN_ROWS)))) return;

    const candidates = selectThreadPrefetchCandidates({
      conversations,
      groups,
      probeDm: (conversationUuid, otherUserUuid) =>
        probeThread(queryClient, ["messages", conversationUuid, otherUserUuid]),
      probeGroup: (conversationUuid) =>
        probeThread(queryClient, ["group-messages", conversationUuid]),
      hasGroupDetail: (conversationUuid) =>
        (queryClient.getQueryState(["group", conversationUuid])?.dataUpdatedAt ?? 0) > 0,
      activeThreadUuid: getActiveMessageThread(),
      now: Date.now(),
    });
    // Лёгкая фаза для ВСЕХ кандидатов до тяжёлых медиа: каждый тред из топа
    // становится «тёплым» (расшифровка+раскладка) за первые секунды прогона.
    if (candidates.length > 0) {
      const slice = mapIdleSliced(candidates, (candidate) => {
        if (getActiveMessageThread() != null) {
          rerunRequested = true;
          return Promise.resolve(undefined);
        }
        return processCandidateThread(candidate, viewerUserUuid, canDecrypt).catch(
          () => undefined,
        );
      });
      activeSlice = slice;
      await slice.done;
      activeSlice = null;
      if (stopped) return;
    }

    // Раскладка чатов за пределами кандидатов — CPU-only, из кэша тредов.
    // Тоже до медиа: тап приходит и в чат глубже топа.
    if (canDecrypt) {
      const candidateKeys = new Set(candidates.map((c) => c.conversationUuid));
      const layoutTargets: ThreadPrefetchCandidate[] = [];
      for (const c of conversations) {
        if (layoutTargets.length >= LAYOUT_WARM_MAX_THREADS) break;
        if (candidateKeys.has(c.conversationUuid)) continue;
        if (!c.conversationUuid.trim()) continue;
        layoutTargets.push({
          kind: "dm",
          conversationUuid: c.conversationUuid,
          otherUserUuid: c.otherUserUuid,
          // Фаза без сети: только кэш треда, догруз не запрашиваем.
          needsMessages: false,
          needsDetail: false,
        });
      }
      for (const g of groups) {
        if (layoutTargets.length >= LAYOUT_WARM_MAX_THREADS) break;
        if (candidateKeys.has(g.conversationUuid)) continue;
        if (!g.conversationUuid.trim()) continue;
        layoutTargets.push({
          kind: "group",
          conversationUuid: g.conversationUuid,
          otherUserUuid: "",
          needsMessages: false,
          needsDetail: false,
        });
      }
      const withCache = layoutTargets.filter(
        (t) =>
          (queryClient.getQueryData<ThreadPage>(threadQueryKey(t))?.items?.length ?? 0) > 0,
      );
      if (withCache.length > 0) {
        const layoutSlice = mapIdleSliced(withCache, (target) => {
          if (getActiveMessageThread() != null) {
            rerunRequested = true;
            return Promise.resolve(undefined);
          }
          return warmThreadLayoutFromCache(target, viewerUserUuid).catch(() => undefined);
        });
        activeSlice = layoutSlice;
        await layoutSlice.done;
        activeSlice = null;
        if (stopped) return;
      }
    }

    // Тяжёлая фаза: вложения и аватары участников — когда все треды уже тёплые.
    if (candidates.length > 0) {
      const mediaBudget = createThreadMediaWarmBudget();
      const mediaSlice = mapIdleSliced(candidates, (candidate) => {
        if (getActiveMessageThread() != null) {
          rerunRequested = true;
          return Promise.resolve(undefined);
        }
        return processCandidateMedia(candidate, canDecrypt, mediaBudget).catch(
          () => undefined,
        );
      });
      activeSlice = mediaSlice;
      await mediaSlice.done;
      activeSlice = null;
      if (stopped) return;
    }

    await warmPreviews(conversations.slice(PREVIEW_FIRST_SCREEN_ROWS));
  };

  const runGuarded = async (): Promise<void> => {
    if (stopped) return;
    if (runInFlight) {
      rerunRequested = true;
      return;
    }
    runInFlight = true;
    try {
      await run();
    } finally {
      runInFlight = false;
      if (rerunRequested && !stopped) {
        rerunRequested = false;
        schedule();
      }
    }
  };

  const schedule = (delayMs: number = EVALUATE_DEBOUNCE_MS): void => {
    if (stopped) return;
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runGuarded();
    }, delayMs);
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" && event.type !== "added") return;
    const head = (event.query.queryKey as readonly unknown[])[0];
    if (head === "conversations" || head === "groups") schedule();
  });

  // Выход из треда — возобновление сразу, а не по 3-секундному переопросу:
  // при быстрых переходах «список → чат → список» окна между чатами короче
  // переопроса, и прогрев иначе не успевал бы вообще.
  const unsubscribeActiveThread = subscribeActiveMessageThread((conversationUuid) => {
    if (conversationUuid == null) schedule(THREAD_CLOSE_RESUME_MS);
  });

  schedule();

  return () => {
    stopped = true;
    unsubscribe();
    unsubscribeActiveThread();
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    activeSlice?.cancel();
    activeSlice = null;
    for (const cancel of avatarPrefetchCancels) cancel();
    avatarPrefetchCancels = [];
  };
}
