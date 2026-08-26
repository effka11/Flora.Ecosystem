/**
 * Политика «тихого» прогрева тредов (Telegram-tier): какие переписки греть и
 * что именно им нужно — сеть (needsMessages/needsDetail) или только
 * предрасшифровка уже закэшированных сообщений.
 *
 * Pure/RN-free: контроллер-биндинг — `lib/chatThreadsPrefetch.ts`.
 */

import type { MsgConversationDto, MsgGroupListItem } from "@flora/client-core/contracts";
import type { FscpImageBlock, FscpVoiceBlock } from "@flora/client-core/fscp";

export const CHAT_PREFETCH_MAX_DM = 12;
export const CHAT_PREFETCH_MAX_GROUPS = 6;
/** Не дёргать сеть по треду, который рефетчился только что (кулдаун). */
export const CHAT_PREFETCH_MIN_REFRESH_AGE_MS = 20_000;

export const CHAT_MEDIA_WARM_IMAGES_PER_THREAD = 6;
export const CHAT_MEDIA_WARM_VOICES_PER_THREAD = 3;
/** Бюджет на один проход контроллера — сумма по всем тредам. */
export const CHAT_MEDIA_WARM_IMAGES_PER_RUN = 24;
export const CHAT_MEDIA_WARM_VOICES_PER_RUN = 12;

export type ThreadFreshnessProbe = {
  hasData: boolean;
  /** createdAt последнего сообщения в кэше треда (oldest-first массив). */
  newestCreatedAt: string | null;
  dataUpdatedAt: number;
  isInvalidated: boolean;
  isFetching: boolean;
};

export type ThreadPrefetchCandidate = {
  kind: "dm" | "group";
  conversationUuid: string;
  /** Пустая строка для групп. */
  otherUserUuid: string;
  /** Тянуть сообщения с сервера (иначе — только decrypt-прогрев кэша). */
  needsMessages: boolean;
  /** Только группы: нет закэшированного roster'а (`["group", uuid]`). */
  needsDetail: boolean;
};

export function threadNeedsMessagesFetch(
  probe: ThreadFreshnessProbe | null,
  lastMessageAt: string | null,
  now: number,
  minRefreshAgeMs: number = CHAT_PREFETCH_MIN_REFRESH_AGE_MS,
): boolean {
  if (!probe || !probe.hasData) return true;
  if (probe.isFetching) return false;
  if (now - probe.dataUpdatedAt < minRefreshAgeMs) return false;
  if (probe.isInvalidated) return true;
  if (lastMessageAt && (!probe.newestCreatedAt || probe.newestCreatedAt < lastMessageAt)) {
    return true;
  }
  return false;
}

function uuidEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/**
 * Топ переписок в порядке видимого списка (unread приоритетнее, затем
 * свежесть); открытый тред исключён — он обновляет себя сам по realtime.
 */
export function selectThreadPrefetchCandidates(params: {
  conversations: readonly MsgConversationDto[];
  groups: readonly MsgGroupListItem[];
  probeDm: (conversationUuid: string, otherUserUuid: string) => ThreadFreshnessProbe | null;
  probeGroup: (conversationUuid: string) => ThreadFreshnessProbe | null;
  hasGroupDetail: (conversationUuid: string) => boolean;
  activeThreadUuid?: string | null;
  now: number;
  maxDm?: number;
  maxGroups?: number;
}): ThreadPrefetchCandidate[] {
  const maxDm = params.maxDm ?? CHAT_PREFETCH_MAX_DM;
  const maxGroups = params.maxGroups ?? CHAT_PREFETCH_MAX_GROUPS;
  const out: ThreadPrefetchCandidate[] = [];

  const dms = [...params.conversations]
    .filter(
      (c) =>
        c.conversationUuid.trim().length > 0 &&
        c.otherUserUuid.trim().length > 0 &&
        !uuidEqual(c.conversationUuid, params.activeThreadUuid),
    )
    .sort((a, b) => {
      const unread = (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0);
      if (unread !== 0) return unread;
      return (b.lastMessageAt || "").localeCompare(a.lastMessageAt || "");
    })
    .slice(0, maxDm);

  for (const c of dms) {
    out.push({
      kind: "dm",
      conversationUuid: c.conversationUuid,
      otherUserUuid: c.otherUserUuid,
      needsMessages: threadNeedsMessagesFetch(
        params.probeDm(c.conversationUuid, c.otherUserUuid),
        c.lastMessageAt || null,
        params.now,
      ),
      needsDetail: false,
    });
  }

  const groups = [...params.groups]
    .filter(
      (g) =>
        g.conversationUuid.trim().length > 0 &&
        !uuidEqual(g.conversationUuid, params.activeThreadUuid),
    )
    .sort((a, b) => {
      const unread = (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0);
      if (unread !== 0) return unread;
      const aAt = a.lastMessageAt || a.createdAt || "";
      const bAt = b.lastMessageAt || b.createdAt || "";
      return bAt.localeCompare(aAt);
    })
    .slice(0, maxGroups);

  for (const g of groups) {
    out.push({
      kind: "group",
      conversationUuid: g.conversationUuid,
      otherUserUuid: "",
      needsMessages: threadNeedsMessagesFetch(
        params.probeGroup(g.conversationUuid),
        g.lastMessageAt,
        params.now,
      ),
      needsDetail: !params.hasGroupDetail(g.conversationUuid),
    });
  }

  return out;
}

/** Расшифрованная строка треда в части медиа (структурный срез ThreadBubbleItem). */
export type ThreadMediaRow = {
  imageBlocks?: readonly FscpImageBlock[];
  voiceBlock?: FscpVoiceBlock;
};

export type ThreadMediaWarmTargets = {
  images: FscpImageBlock[];
  voices: FscpVoiceBlock[];
};

/** Остаток медиа-бюджета прохода; selectThreadMediaWarmTargets его уменьшает. */
export type ThreadMediaWarmBudget = { images: number; voices: number };

export function createThreadMediaWarmBudget(): ThreadMediaWarmBudget {
  return {
    images: CHAT_MEDIA_WARM_IMAGES_PER_RUN,
    voices: CHAT_MEDIA_WARM_VOICES_PER_RUN,
  };
}

/**
 * Медиа новейших сообщений треда под прогрев (rows oldest-first — идём с
 * конца): пользователь открывает низ ленты, значит первыми должны быть готовы
 * вложения последних сообщений. Пер-тредовые капы держат один медиа-тяжёлый
 * тред от съедания всего бюджета прохода.
 */
export function selectThreadMediaWarmTargets(
  rows: readonly ThreadMediaRow[],
  budget: ThreadMediaWarmBudget,
  caps: { imagesPerThread?: number; voicesPerThread?: number } = {},
): ThreadMediaWarmTargets {
  const imagesCap = Math.min(
    caps.imagesPerThread ?? CHAT_MEDIA_WARM_IMAGES_PER_THREAD,
    Math.max(0, budget.images),
  );
  const voicesCap = Math.min(
    caps.voicesPerThread ?? CHAT_MEDIA_WARM_VOICES_PER_THREAD,
    Math.max(0, budget.voices),
  );
  const images: FscpImageBlock[] = [];
  const voices: FscpVoiceBlock[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (images.length >= imagesCap && voices.length >= voicesCap) break;
    const row = rows[i]!;
    if (row.voiceBlock && voices.length < voicesCap) {
      voices.push(row.voiceBlock);
    }
    if (row.imageBlocks) {
      for (const block of row.imageBlocks) {
        if (images.length >= imagesCap) break;
        images.push(block);
      }
    }
  }
  budget.images -= images.length;
  budget.voices -= voices.length;
  return { images, voices };
}
