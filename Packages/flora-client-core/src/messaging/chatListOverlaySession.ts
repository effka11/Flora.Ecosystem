/**
 * Shared chat-list overlay sync (Web + Mobile).
 * SoT — Messaging HTTP; persistence — offline cache only.
 * HTTP transport injected (keeps `@flora/client-core/messaging` free of `./api`).
 */
import {
  addPeerToChatListEntity,
  canArchiveChatListPeer,
  canCreateChatListFolder,
  chatListEntityFromApi,
  chatListOverlayFromApi,
  CHAT_LIST_FOLDER_LABEL_MAX,
  countArchivedPeers,
  emptyChatListOverlayState,
  isChatListFolderIconName,
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

  /** Cached for `useSyncExternalStore` — getSnapshot must be referentially stable. */
  let snapshot: ChatListOverlaySnapshot = {
    ownerUserUuid: null,
    state: emptyChatListOverlayState(),
    syncing: false,
  };
  let refreshSeq = 0;
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) listener();
  }

  function getSnapshot(): ChatListOverlaySnapshot {
    return snapshot;
  }

  function setLocal(partial: {
    ownerUserUuid?: string | null;
    state?: ChatListOverlayState;
    syncing?: boolean;
  }) {
    const ownerUserUuid =
      partial.ownerUserUuid !== undefined ? partial.ownerUserUuid : snapshot.ownerUserUuid;
    const state = partial.state !== undefined ? partial.state : snapshot.state;
    const syncing = partial.syncing !== undefined ? partial.syncing : snapshot.syncing;
    if (
      ownerUserUuid === snapshot.ownerUserUuid &&
      state === snapshot.state &&
      syncing === snapshot.syncing
    ) {
      return;
    }
    snapshot = { ownerUserUuid, state, syncing };
    emit();
  }

  function persist(owner: string, next: ChatListOverlayState) {
    persistence.write(owner, next);
    setLocal({ state: next });
  }

  async function refresh(): Promise<void> {
    const owner = snapshot.ownerUserUuid;
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
      if (snapshot.ownerUserUuid !== owner || seq !== refreshSeq) return;
      persist(owner, next);
    } catch (error) {
      warn?.("[chatListOverlay] refresh failed", error);
    } finally {
      if (snapshot.ownerUserUuid === owner && seq === refreshSeq) {
        setLocal({ syncing: false });
      }
    }
  }

  function hydrate(userUuid: string | null) {
    const owner = userUuid?.trim() || null;
    if (snapshot.ownerUserUuid === owner && owner) {
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
    const owner = snapshot.ownerUserUuid;
    if (!owner) return null;
    const archivedCount = countArchivedPeers(snapshot.state.archivedByPeer);
    if (!canCreateChatListFolder(archivedCount, snapshot.state.entities.length)) {
      warn?.("[chatListOverlay] create blocked: folder icon limit");
      return null;
    }
    if (!isChatListFolderIconName(params.icon)) {
      warn?.("[chatListOverlay] create blocked: bad icon", params.icon);
      return null;
    }
    try {
      ensureHttp?.();
      const raw = await http.createFolder({
        kind: "folder",
        label: (params.label?.trim() || "Папка").slice(0, CHAT_LIST_FOLDER_LABEL_MAX),
        icon: params.icon,
        memberPeerUuids: params.memberPeerUuids,
      });
      const entity = chatListEntityFromApi(raw);
      if (!entity) {
        await refresh();
        return null;
      }
      const prev = snapshot.state;
      persist(owner, {
        ...prev,
        entities: [...prev.entities.filter((e) => e.id !== entity.id), entity],
      });
      await refresh();
      return snapshot.state.entities.find((e) => e.id === entity.id) ?? entity;
    } catch (error) {
      warn?.("[chatListOverlay] create failed", error);
      return null;
    }
  }

  async function addPeerToFolder(entityId: string, peerUuid: string): Promise<void> {
    const owner = snapshot.ownerUserUuid;
    if (!owner) return;
    const prev = snapshot.state;
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
    const owner = snapshot.ownerUserUuid;
    if (!owner) return;
    const prev = snapshot.state;
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
    const owner = snapshot.ownerUserUuid;
    if (!owner || !peerUuid.trim() || !conversationUuid.trim()) return false;
    const prev = snapshot.state;
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
    const owner = snapshot.ownerUserUuid;
    if (!owner || !peerUuid.trim() || !conversationUuid.trim()) return;
    const prev = snapshot.state;
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
