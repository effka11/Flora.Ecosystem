/**
 * Маппинг UI overlay state ↔ FSCP-ORG plaintext (structural, без @flora/fscp).
 */
import {
  CHAT_LIST_FOLDER_LABEL_MAX,
  emptyChatListOverlayState,
  type ChatListCustomEntity,
  type ChatListOverlayState,
} from "./chatListFolders.js";

/** Structural match for `FscpOrganizerStatePlaintext` (Apps pass into @flora/fscp). */
export type ChatOrganizerPlaintext = {
  type: "chat-organizer";
  version: 1;
  entities: Array<{
    id: string;
    kind: "folder" | "group";
    label: string;
    icon?: string;
    avatarUri?: string | null;
    memberPeerUuids: string[];
    memberConversationUuids: string[];
    createdAtMs: number;
  }>;
  archivedByPeer: Record<string, true>;
  mutedByPeer: Record<string, true>;
  archivedByConversation: Record<string, true>;
  mutedByConversation: Record<string, true>;
  clientUpdatedAt: string;
};

export function overlayStateToOrganizerPlaintext(
  state: ChatListOverlayState,
  nowIso?: string,
): ChatOrganizerPlaintext {
  return {
    type: "chat-organizer",
    version: 1,
    entities: state.entities.map((e) => ({
      id: e.id,
      kind: e.kind,
      label: e.label.slice(0, CHAT_LIST_FOLDER_LABEL_MAX),
      icon: e.icon,
      avatarUri: e.avatarUri ?? null,
      memberPeerUuids: [...e.memberPeerUuids],
      memberConversationUuids: [...(e.memberConversationUuids ?? [])],
      createdAtMs: e.createdAtMs,
    })),
    archivedByPeer: { ...state.archivedByPeer },
    mutedByPeer: { ...state.mutedByPeer },
    archivedByConversation: { ...(state.archivedByConversation ?? {}) },
    mutedByConversation: { ...(state.mutedByConversation ?? {}) },
    clientUpdatedAt: nowIso ?? new Date().toISOString(),
  };
}

export function organizerPlaintextToOverlayState(
  plain: ChatOrganizerPlaintext,
  meta?: { revision?: number; migratedToOrg?: boolean },
): ChatListOverlayState {
  const entities: ChatListCustomEntity[] = plain.entities.map((e) => ({
    id: e.id,
    kind: e.kind,
    label: e.label.slice(0, CHAT_LIST_FOLDER_LABEL_MAX),
    icon: e.icon,
    avatarUri: e.avatarUri,
    memberPeerUuids: [...e.memberPeerUuids],
    memberConversationUuids: [...(e.memberConversationUuids ?? [])],
    createdAtMs: e.createdAtMs,
  }));
  return {
    v: 1,
    entities,
    archivedByPeer: { ...plain.archivedByPeer },
    mutedByPeer: { ...plain.mutedByPeer },
    archivedByConversation: { ...plain.archivedByConversation },
    mutedByConversation: { ...plain.mutedByConversation },
    revision: meta?.revision ?? 0,
    migratedToOrg: meta?.migratedToOrg ?? true,
  };
}

/** Merge local cache with plaintext overlay for first-time migrate. */
export function mergeOverlayForMigrate(
  local: ChatListOverlayState,
  fromApi: ChatListOverlayState | null,
): ChatListOverlayState {
  if (!fromApi) return local;
  const byId = new Map<string, ChatListCustomEntity>();
  for (const e of fromApi.entities) byId.set(e.id, e);
  for (const e of local.entities) byId.set(e.id, e);
  return {
    v: 1,
    entities: [...byId.values()],
    archivedByPeer: { ...fromApi.archivedByPeer, ...local.archivedByPeer },
    mutedByPeer: { ...fromApi.mutedByPeer, ...local.mutedByPeer },
    archivedByConversation: {
      ...(fromApi.archivedByConversation ?? {}),
      ...(local.archivedByConversation ?? {}),
    },
    mutedByConversation: {
      ...(fromApi.mutedByConversation ?? {}),
      ...(local.mutedByConversation ?? {}),
    },
    revision: 0,
    migratedToOrg: false,
  };
}

export function emptyOrganizerPlaintext(nowIso?: string): ChatOrganizerPlaintext {
  return overlayStateToOrganizerPlaintext(emptyChatListOverlayState(), nowIso);
}
