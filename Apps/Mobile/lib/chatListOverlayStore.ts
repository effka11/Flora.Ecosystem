/**
 * Оверлей списка чатов: кэш MMKV + sync с Messaging API (без FSCP).
 * SoT — сервер; MMKV только офлайн-кэш. Reconcile — latest-wins.
 * Доменная логика — `@flora/client-core/messaging`.
 */
import {
  apiAddChatFolderMember,
  apiArchiveConversation,
  apiCreateChatFolder,
  apiDeleteChatFolder,
  apiGetChatListOverlay,
  apiMuteConversation,
  apiUnarchiveConversation,
  apiUnmuteConversation,
} from "@flora/client-core/api";
import {
  addPeerToChatListEntity,
  canArchiveChatListPeer,
  chatListEntityFromApi,
  chatListOverlayFromApi,
  countArchivedPeers,
  emptyChatListOverlayState,
  parseChatListOverlayState,
  pruneArchivedPeers,
  removeChatListEntity,
  setPeerArchivedFlag,
  setPeerMutedFlag,
  type ChatListCustomEntity,
  type ChatListOverlayState,
} from "@flora/client-core/messaging";
import { create } from "zustand";
import { mmkv } from "@/lib/mmkv";

/** v2: сброс кэша эпохи «папки только в MMKV». */
const KEY_PREFIX = "chatListOverlay:v2:";

function storageKey(userUuid: string): string {
  return `${KEY_PREFIX}${userUuid.trim().toLowerCase()}`;
}

function readState(userUuid: string | null | undefined): ChatListOverlayState {
  if (!userUuid?.trim()) return emptyChatListOverlayState();
  const raw = mmkv.getString(storageKey(userUuid));
  if (!raw) return emptyChatListOverlayState();
  try {
    const parsed = parseChatListOverlayState(JSON.parse(raw) as unknown);
    return parsed ?? emptyChatListOverlayState();
  } catch {
    return emptyChatListOverlayState();
  }
}

function writeState(userUuid: string, state: ChatListOverlayState): void {
  mmkv.set(storageKey(userUuid), JSON.stringify(state));
}

type ChatListOverlayStore = {
  ownerUserUuid: string | null;
  state: ChatListOverlayState;
  syncing: boolean;
  /** Монотонный номер GET; применяется только последний. */
  refreshSeq: number;
  hydrate: (userUuid: string | null) => void;
  refreshFromServer: () => Promise<void>;
  createFolder: (params: {
    icon: string;
    memberPeerUuids: readonly string[];
    label?: string;
  }) => Promise<ChatListCustomEntity | null>;
  createGroup: (params: {
    name: string;
    avatarUri?: string | null;
    memberPeerUuids: readonly string[];
  }) => Promise<ChatListCustomEntity | null>;
  addPeerToEntity: (entityId: string, peerUuid: string) => Promise<void>;
  removeEntity: (entityId: string) => Promise<void>;
  setArchived: (
    peerUuid: string,
    conversationUuid: string,
    archived: boolean,
  ) => Promise<void>;
  setMuted: (peerUuid: string, conversationUuid: string, muted: boolean) => Promise<void>;
  pruneUnknownPeers: (knownPeerUuids: ReadonlySet<string>) => void;
};

export const useChatListOverlayStore = create<ChatListOverlayStore>((set, get) => ({
  ownerUserUuid: null,
  state: emptyChatListOverlayState(),
  syncing: false,
  refreshSeq: 0,

  hydrate(userUuid) {
    const owner = userUuid?.trim() || null;
    if (get().ownerUserUuid === owner && owner) {
      void get().refreshFromServer();
      return;
    }
    set({
      ownerUserUuid: owner,
      state: readState(owner),
    });
    if (owner) void get().refreshFromServer();
  },

  async refreshFromServer() {
    const owner = get().ownerUserUuid;
    if (!owner) return;
    const seq = get().refreshSeq + 1;
    set({ refreshSeq: seq, syncing: true });
    try {
      const raw = await apiGetChatListOverlay();
      const next = chatListOverlayFromApi(raw);
      if (!next) {
        if (__DEV__) console.warn("[chatListOverlay] GET ok but parse failed", raw);
        return;
      }
      if (get().ownerUserUuid !== owner || get().refreshSeq !== seq) return;
      writeState(owner, next);
      set({ state: next });
    } catch (error) {
      if (__DEV__) console.warn("[chatListOverlay] refresh failed", error);
    } finally {
      if (get().ownerUserUuid === owner && get().refreshSeq === seq) {
        set({ syncing: false });
      }
    }
  },

  async createFolder(params) {
    const owner = get().ownerUserUuid;
    if (!owner) return null;
    try {
      const raw = await apiCreateChatFolder({
        kind: "folder",
        label: (params.label?.trim() || "Папка").slice(0, 40),
        icon: params.icon,
        memberPeerUuids: params.memberPeerUuids,
      });
      const entity = chatListEntityFromApi(raw);
      if (!entity) {
        await get().refreshFromServer();
        return null;
      }
      const state: ChatListOverlayState = {
        ...get().state,
        entities: [...get().state.entities.filter((e) => e.id !== entity.id), entity],
      };
      writeState(owner, state);
      set({ state });
      await get().refreshFromServer();
      return get().state.entities.find((e) => e.id === entity.id) ?? entity;
    } catch (error) {
      if (__DEV__) console.warn("[chatListOverlay] create failed", error);
      return null;
    }
  },

  async createGroup(params) {
    const owner = get().ownerUserUuid;
    if (!owner) return null;
    const name = params.name.trim();
    if (!name || params.memberPeerUuids.length === 0) return null;
    try {
      const raw = await apiCreateChatFolder({
        kind: "group",
        label: name.slice(0, 80),
        avatarUri: params.avatarUri,
        memberPeerUuids: params.memberPeerUuids,
      });
      const entity = chatListEntityFromApi(raw);
      if (!entity) {
        await get().refreshFromServer();
        return null;
      }
      const state: ChatListOverlayState = {
        ...get().state,
        entities: [...get().state.entities.filter((e) => e.id !== entity.id), entity],
      };
      writeState(owner, state);
      set({ state });
      await get().refreshFromServer();
      return get().state.entities.find((e) => e.id === entity.id) ?? entity;
    } catch (error) {
      if (__DEV__) console.warn("[chatListOverlay] createGroup failed", error);
      return null;
    }
  },

  async addPeerToEntity(entityId, peerUuid) {
    const owner = get().ownerUserUuid;
    if (!owner) return;
    const prev = get().state;
    const entities = addPeerToChatListEntity(prev.entities, entityId, peerUuid);
    if (entities === prev.entities) return;
    const state = { ...prev, entities };
    writeState(owner, state);
    set({ state });
    try {
      await apiAddChatFolderMember(entityId, peerUuid);
      await get().refreshFromServer();
    } catch {
      writeState(owner, prev);
      set({ state: prev });
    }
  },

  async removeEntity(entityId) {
    const owner = get().ownerUserUuid;
    if (!owner) return;
    const prev = get().state;
    const entities = removeChatListEntity(prev.entities, entityId);
    if (entities === prev.entities) return;
    const state = { ...prev, entities };
    writeState(owner, state);
    set({ state });
    try {
      await apiDeleteChatFolder(entityId);
      await get().refreshFromServer();
    } catch {
      writeState(owner, prev);
      set({ state: prev });
    }
  },

  async setArchived(peerUuid, conversationUuid, archived) {
    const owner = get().ownerUserUuid;
    if (!owner || !peerUuid.trim() || !conversationUuid.trim()) return;
    const prev = get().state;
    if (archived) {
      const archivedCount = countArchivedPeers(prev.archivedByPeer);
      if (!canArchiveChatListPeer(archivedCount, prev.entities.length)) return;
    }
    const archivedByPeer = setPeerArchivedFlag(prev.archivedByPeer, peerUuid, archived);
    if (archivedByPeer === prev.archivedByPeer) return;
    const state = { ...prev, archivedByPeer };
    writeState(owner, state);
    set({ state });
    try {
      if (archived) await apiArchiveConversation(conversationUuid, peerUuid);
      else await apiUnarchiveConversation(conversationUuid, peerUuid);
      await get().refreshFromServer();
    } catch {
      writeState(owner, prev);
      set({ state: prev });
    }
  },

  async setMuted(peerUuid, conversationUuid, muted) {
    const owner = get().ownerUserUuid;
    if (!owner || !peerUuid.trim() || !conversationUuid.trim()) return;
    const prev = get().state;
    const mutedByPeer = setPeerMutedFlag(prev.mutedByPeer, peerUuid, muted);
    if (mutedByPeer === prev.mutedByPeer) return;
    const state = { ...prev, mutedByPeer };
    writeState(owner, state);
    set({ state });
    try {
      if (muted) await apiMuteConversation(conversationUuid, peerUuid);
      else await apiUnmuteConversation(conversationUuid, peerUuid);
      await get().refreshFromServer();
    } catch {
      writeState(owner, prev);
      set({ state: prev });
    }
  },

  pruneUnknownPeers(knownPeerUuids) {
    const owner = get().ownerUserUuid;
    if (!owner) return;
    const archivedByPeer = pruneArchivedPeers(get().state.archivedByPeer, knownPeerUuids);
    const mutedByPeer = pruneArchivedPeers(get().state.mutedByPeer, knownPeerUuids);
    if (
      archivedByPeer === get().state.archivedByPeer &&
      mutedByPeer === get().state.mutedByPeer
    ) {
      return;
    }
    const state = { ...get().state, archivedByPeer, mutedByPeer };
    writeState(owner, state);
    set({ state });
  },
}));
