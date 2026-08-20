import type { GroupChat } from "@/lib/groupChatTypes";
import { mapIdleSliced, type IdleSlicedDeps } from "@/lib/idleScrollGate";

export type WarmGroupListPreviewsDeps = IdleSlicedDeps & {
  decryptOne: (group: GroupChat) => Promise<string>;
};

export type WarmGroupListPreviewsHandle = {
  cancel: () => void;
  done: Promise<Record<string, string> | null>;
};

/** Idle-sliced group-preview warm. Same pause/yield rules as DM list previews. */
export function warmGroupListPreviews(
  groups: readonly GroupChat[],
  deps: WarmGroupListPreviewsDeps,
): WarmGroupListPreviewsHandle {
  const sliced = mapIdleSliced(groups, (group) => deps.decryptOne(group), deps);
  const done = sliced.done.then((rows) => {
    if (!rows) return null;
    const next: Record<string, string> = {};
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const text = rows[i];
      if (group == null || text == null) continue;
      next[group.conversationUuid] = text;
    }
    return next;
  });
  return { cancel: sliced.cancel, done };
}
