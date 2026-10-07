import { avatarImageUrl } from "@flora/client-core/display";
import { Image } from "expo-image";
import {
  CHAT_OPEN_AVATAR_FIRST_FRAME_CACHE,
  chatOpenAvatarsReadyNow,
  noteChatOpenAvatarDecoded,
  noteChatOpenAvatarPrefetched,
  warmChatOpenAvatarBitmaps,
  whenChatOpenAvatarsFirstFrame,
  type ChatAvatarWarmPace,
  type ChatOpenAvatarFramePace,
} from "@/lib/chatOpenAvatars";
import { peekFrcImageFile, whenFrcImageReady } from "@/lib/frcImage";
import { floraMessages } from "@/lib/theme";

/** Cold decode stays off the carpet. Past this, the circle keeps initials. */
const AVATAR_READY_CAP_MS = 400;
/**
 * После холодного декода круг треда обязан снять onLoad до слайда. Потолок —
 * страховка: без него круг, который так и не нарисовался, держал бы ковёр.
 */
const AVATAR_PAINT_CAP_MS = 200;

function avatarPeekUri(uuid: string): string {
  return peekFrcImageFile(avatarImageUrl(uuid), floraMessages.peerBubbleAvatarSize);
}

/**
 * Файлы кругов уже в индексе того же bucket (3×grid), что и у строки списка,
 * и ни один не ждёт onLoad: ковёр можно гасить синхронно, без prefetch.
 */
export function parkedChatAvatarsReadyNow(uuids: readonly string[]): boolean {
  return chatOpenAvatarsReadyNow(uuids, avatarPeekUri);
}

export function warmParkedChatAvatars(
  uuids: readonly (string | null | undefined)[],
): Promise<ChatAvatarWarmPace> {
  const displayWidth = floraMessages.peerBubbleAvatarSize;
  return warmChatOpenAvatarBitmaps(uuids, {
    displayWidth,
    ready: (uuid) => {
      const url = avatarImageUrl(uuid);
      const peeked = peekFrcImageFile(url, displayWidth);
      if (peeked) return Promise.resolve({ pace: "cached", uri: peeked });
      return whenFrcImageReady(url, {
        displayWidth,
        lane: "avatar",
        timeoutMs: AVATAR_READY_CAP_MS,
      }).then((uri) => {
        noteChatOpenAvatarDecoded(uuid);
        return { pace: "decoded" as const, uri };
      });
    },
    prefetch: async (uris) => {
      await Image.prefetch([...uris], "memory-disk");
    },
  });
}

/**
 * Скамья, не тап. Файл в индексе ещё не bitmap: `Image.prefetch` в тот же
 * `memory`, что читает первый кадр круга. Попадание отмечает готовность.
 * Промах или другой cache отметку не ставит — ковёр ждёт onLoad.
 * Повтор на уже готовый круг не зовёт prefetch: на тапе он держал ковёр,
 * хотя строка списка этот URI уже декодировала.
 */
export async function prefetchMeasuringChatAvatars(
  uuids: readonly (string | null | undefined)[],
): Promise<void> {
  const pending: { id: string; uri: string }[] = [];
  for (const raw of uuids) {
    const id = raw?.trim() ?? "";
    if (!id || parkedChatAvatarsReadyNow([id])) continue;
    const uri = avatarPeekUri(id);
    if (!uri) continue;
    pending.push({ id, uri });
  }
  if (pending.length === 0) return;
  let filled = false;
  try {
    filled = await Image.prefetch(
      pending.map((item) => item.uri),
      CHAT_OPEN_AVATAR_FIRST_FRAME_CACHE,
    );
  } catch {
    return;
  }
  if (!filled) return;
  for (const item of pending) {
    noteChatOpenAvatarPrefetched(item.id, CHAT_OPEN_AVATAR_FIRST_FRAME_CACHE);
  }
}

/**
 * Декод кругов треда уже мог идти с press-in. Prefetch на этот вызов не
 * вешается: тап не должен ждать memory-prefetch, если строка списка уже
 * декодировала URI. Готовность — onLoad или отметка cache первого кадра.
 * Потолок отпускает показ; `capped` — открытие не тёплое.
 */
export async function finishParkedAvatarWarm(
  uuids: readonly string[],
): Promise<ChatOpenAvatarFramePace> {
  if (parkedChatAvatarsReadyNow(uuids)) return "ready";
  void warmParkedChatAvatars(uuids);
  return whenChatOpenAvatarsFirstFrame(uuids, avatarPeekUri, {
    timeoutMs: AVATAR_PAINT_CAP_MS,
  });
}
