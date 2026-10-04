/** Режим публикации на стену текущего профиля (вкладка с именем пользователя). */
export const COMPOSE_PROFILE_MODE_ID = "primary";

/** Префикс id подвкладки сообщества: `community:<uuid>`. */
export const COMPOSE_COMMUNITY_MODE_PREFIX = "community:";

/** Дополнительные режимы создания поста — подключать по мере появления. */
export const COMPOSE_MODE_EXTRA: { id: string; label: string }[] = [];

export type ComposeDraftScope = {
  composeModeId: string;
  /** undefined = стена профиля; иначе uuid сообщества. */
  communityId?: string;
  scopeKey: string;
};

export function composeCommunityModeId(communityId: string): string {
  return `${COMPOSE_COMMUNITY_MODE_PREFIX}${communityId}`;
}

export function isComposeCommunityModeId(mode: string): boolean {
  if (!mode.startsWith(COMPOSE_COMMUNITY_MODE_PREFIX)) return false;
  return mode.slice(COMPOSE_COMMUNITY_MODE_PREFIX.length).trim().length > 0;
}

export function isComposeModeId(mode: string): boolean {
  return (
    mode === COMPOSE_PROFILE_MODE_ID ||
    isComposeCommunityModeId(mode) ||
    COMPOSE_MODE_EXTRA.some((item) => item.id === mode)
  );
}

export function composeModeToDraftScope(composeModeId: string): ComposeDraftScope {
  if (composeModeId === COMPOSE_PROFILE_MODE_ID) {
    return { composeModeId, scopeKey: COMPOSE_PROFILE_MODE_ID };
  }
  if (composeModeId.startsWith(COMPOSE_COMMUNITY_MODE_PREFIX)) {
    const communityId = composeModeId.slice(COMPOSE_COMMUNITY_MODE_PREFIX.length).trim();
    if (communityId) {
      return { composeModeId, communityId, scopeKey: composeModeId };
    }
  }
  return { composeModeId, scopeKey: composeModeId };
}
