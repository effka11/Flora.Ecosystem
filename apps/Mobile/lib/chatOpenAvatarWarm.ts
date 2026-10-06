import { avatarImageUrl } from "@flora/client-core/display";
import { Image } from "expo-image";
import {
  noteChatOpenAvatarDecoded,
  warmChatOpenAvatarBitmaps,
  type ChatAvatarWarmPace,
} from "@/lib/chatOpenAvatars";
import { peekFrcImageFile, whenFrcImageReady } from "@/lib/frcImage";
import { floraMessages } from "@/lib/theme";

/** Cold decode stays off the carpet. Past this, the circle keeps initials. */
const AVATAR_READY_CAP_MS = 400;

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
