/**
 * Shared chat-list overlay sync (Web + Mobile).
 * SoT — Messaging HTTP; persistence — offline cache only.
 * HTTP transport injected (keeps `@flora/client-core/messaging` free of `./api`).
 */
import {
  addPeerToChatListEntity,
  canArchiveChatListPeer,
  chatListEntityFromApi,
  chatListOverlayFromApi,
  countArchivedPeers,
  emptyChatListOverlayState,
  removeChatListEntity,
  setPeerArchivedFlag,
  setPeerMutedFlag,
  type ChatListCustomEntity,
  type ChatListOverlayState,
} from "./chatListFolders.js";

export type ChatListOverlayHttp = {
  getOverlay: () => Promise<unknown>;
  createFolder: (body: {
    kind: "folder" | "group";
    label: string;
    icon?: string;
    avatarUri?: string | null;
    memberPeerUuids?: readonly string[];
  }) => Promise<unknown>;
  deleteFolder: (folderId: string) => Promise<void>;
  addMember: (folderId: string, otherUserUuid: string) => Promise<void>;
  archive: (conversationUuid: string, otherUserUuid: string) => Promise<void>;
  unarchive: (conversationUuid: string, otherUserUuid: string) => Promise<void>;
  mute: (conversationUuid: string, otherUserUuid: string) => Promise<void>;
  unmute: (conversationUuid: string, otherUserUuid: string) => Promise<void>;
};

export type ChatListOverlayPersistence = {
  read: (ownerUserUuid: string) => ChatListOverlayState;
  write: (ownerUserUuid: string, state: ChatListOverlayState) => void;
};

export type ChatListOverlaySnapshot = {
  ownerUserUuid: string | null;
  state: ChatListOverlayState;
  syncing: boolean;
};

export type ChatListOverlaySession = {
  getSnapshot: () => ChatListOverlaySnapshot;
  subscribe: (listener: () => void) => () => void;
  hydrate: (userUuid: string | null) => void;
  refresh: () => Promise<void>;
  createFolder: (params: {
    icon: string;
    memberPeerUuids: readonly string[];
    label?: string;
  }) => Promise<ChatListCustomEntity | null>;
  addPeerToFolder: (entityId: string, peerUuid: string) => Promise<void>;
  removeFolder: (entityId: string) => Promise<void>;
  setArchived: (
    peerUuid: string,
    conversationUuid: string,
    archived: boolean,
  ) => Promise<boolean>;
  setMuted: (peerUuid: string, conversationUuid: string, muted: boolean) => Promise<void>;
};

export function createChatListOverlaySession(options: {
  http: ChatListOverlayHttp;
  persistence: ChatListOverlayPersistence;
  /** Called before each HTTP call (e.g. Web `initWebApiClient`). */
  ensureHttp?: () => void;
  warn?: (message: string, detail?: unknown) => void;
}): ChatListOverlaySession {
  const { http, persistence, ensureHttp, warn } = options;

  let ownerUserUuid: string | null = null;
  let state: ChatListOverlayState = emptyChatListOverlayState();
  let syncing = false;
  let refreshSeq = 0;
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) listener();
  }

  function getSnapshot(): ChatListOverlaySnapshot {
    return { ownerUserUuid, state, syncing };
  }

  function setLocal(partial: {
    ownerUserUuid?: string | null;
    state?: ChatListOverlayState;
    syncing?: boolean;
  }) {
    if (partial.ownerUserUuid !== undefined) ownerUserUuid = partial.ownerUserUuid;
    if (partial.state !== undefined) state = partial.state;
    if (partial.syncing !== undefined) syncing = partial.syncing;
    emit();
  }

  function persist(owner: string, next: ChatListOverlayState) {
    persistence.write(owner, next);
    setLocal({ state: next });
  }

  async function refresh(): Promise<void> {
    const owner = ownerUserUuid;
    if (!owner) return;
    const seq = ++refreshSeq;
    setLocal({ syncing: true });
    try {
      ensureHttp?.();
      const raw = await http.getOverlay();
      const next = chatListOverlayFromApi(raw);
      if (!next) {
        warn?.("[chatListOverlay] GET ok but parse failed", raw);
        return;
      }
      if (ownerUserUuid !== owner || seq !== refreshSeq) return;
      persist(owner, next);
    } catch (error) {
      warn?.("[chatListOverlay] refresh failed", error);
    } finally {
      if (ownerUserUuid === owner && seq === refreshSeq) {
        setLocal({ syncing: false });
      }
    }
  }

  function hydrate(userUuid: string | null) {
    const owner = userUuid?.trim() || null;
    if (ownerUserUuid === owner && owner) {
      void refresh();
      return;
    }
    setLocal({
      ownerUserUuid: owner,
      state: owner ? persistence.read(owner) : emptyChatListOverlayState(),
    });
    if (owner) void refresh();
  }

  async function createFolder(params: {
    icon: string;
    memberPeerUuids: readonly string[];
    label?: string;
  }): Promise<ChatListCustomEntity | null> {
    const owner = ownerUserUuid;
    if (!owner) return null;
    try {
      ensureHttp?.();
      const raw = await http.createFolder({
        kind: "folder",
        label: (params.label?.trim() || "Папка").slice(0, 40),
        icon: params.icon,
        memberPeerUuids: params.memberPeerUuids,
      });
      const entity = chatListEntityFromApi(raw);
      if (!entity) {
        await refresh();
        return null;
      }
      persist(owner, {
        ...state,
        entities: [...state.entities.filter((e) => e.id !== entity.id), entity],
      });
      await refresh();
      return state.entities.find((e) => e.id === entity.id) ?? entity;
    } catch (error) {
      warn?.("[chatListOverlay] create failed", error);
      return null;
    }
  }

  async function addPeerToFolder(entityId: string, peerUuid: string): Promise<void> {
    const owner = ownerUserUuid;
    if (!owner) return;
    const prev = state;
    const entities = addPeerToChatListEntity(prev.entities, entityId, peerUuid);
    if (entities === prev.entities) return;
    persist(owner, { ...prev, entities });
    try {
      ensureHttp?.();
      await http.addMember(entityId, peerUuid);
      await refresh();
    } catch {
      persist(owner, prev);
    }
  }

  async function removeFolder(entityId: string): Promise<void> {
    const owner = ownerUserUuid;
    if (!owner) return;
    const prev = state;
    const entities = removeChatListEntity(prev.entities, entityId);
    if (entities === prev.entities) return;
    persist(owner, { ...prev, entities });
    try {
      ensureHttp?.();
      await http.deleteFolder(entityId);
      await refresh();
    } catch {
      persist(owner, prev);
    }
  }

  async function setArchived(
    peerUuid: string,
    conversationUuid: string,
    archived: boolean,
  ): Promise<boolean> {
    const owner = ownerUserUuid;
    if (!owner || !peerUuid.trim() || !conversationUuid.trim()) return false;
    const prev = state;
    if (archived) {
      const archivedCount = countArchivedPeers(prev.archivedByPeer);
      if (!canArchiveChatListPeer(archivedCount, prev.entities.length)) return false;
    }
    const archivedByPeer = setPeerArchivedFlag(prev.archivedByPeer, peerUuid, archived);
    if (archivedByPeer === prev.archivedByPeer) return true;
    persist(owner, { ...prev, archivedByPeer });
    try {
      ensureHttp?.();
      if (archived) await http.archive(conversationUuid, peerUuid);
      else await http.unarchive(conversationUuid, peerUuid);
      await refresh();
      return true;
    } catch {
      persist(owner, prev);
      return false;
    }
  }

  async function setMuted(
    peerUuid: string,
    conversationUuid: string,
    muted: boolean,
  ): Promise<void> {
    const owner = ownerUserUuid;
    if (!owner || !peerUuid.trim() || !conversationUuid.trim()) return;
    const prev = state;
    const mutedByPeer = setPeerMutedFlag(prev.mutedByPeer, peerUuid, muted);
    if (mutedByPeer === prev.mutedByPeer) return;
    persist(owner, { ...prev, mutedByPeer });
    try {
      ensureHttp?.();
      if (muted) await http.mute(conversationUuid, peerUuid);
      else await http.unmute(conversationUuid, peerUuid);
      await refresh();
    } catch {
      persist(owner, prev);
    }
  }

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrate,
    refresh,
    createFolder,
    addPeerToFolder,
    removeFolder,
    setArchived,
    setMuted,
  };
}
