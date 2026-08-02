/**
 * Оверлей списка чатов (Mobile): MMKV-кэш + shared session из client-core.
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
  createChatListOverlaySession,
  emptyChatListOverlayState,
  parseChatListOverlayState,
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

function readState(userUuid: string): ChatListOverlayState {
  const raw = mmkv.getString(storageKey(userUuid));
  if (!raw) return emptyChatListOverlayState();
  try {
    return parseChatListOverlayState(JSON.parse(raw) as unknown) ?? emptyChatListOverlayState();
  } catch {
    return emptyChatListOverlayState();
  }
}

function writeState(userUuid: string, state: ChatListOverlayState): void {
  mmkv.set(storageKey(userUuid), JSON.stringify(state));
}

const session = createChatListOverlaySession({
  warn: __DEV__ ? (message, detail) => console.warn(message, detail) : undefined,
  http: {
    getOverlay: apiGetChatListOverlay,
    createFolder: apiCreateChatFolder,
    deleteFolder: apiDeleteChatFolder,
    addMember: apiAddChatFolderMember,
    archive: apiArchiveConversation,
    unarchive: apiUnarchiveConversation,
    mute: apiMuteConversation,
    unmute: apiUnmuteConversation,
  },
  persistence: {
    read: readState,
    write: writeState,
  },
});

type ChatListOverlayStore = {
  ownerUserUuid: string | null;
  state: ChatListOverlayState;
  syncing: boolean;
  hydrate: (userUuid: string | null) => void;
  refreshFromServer: () => Promise<void>;
  createFolder: (params: {
    icon: string;
    memberPeerUuids: readonly string[];
    label?: string;
  }) => Promise<ChatListCustomEntity | null>;
  addPeerToEntity: (entityId: string, peerUuid: string) => Promise<void>;
  removeEntity: (entityId: string) => Promise<void>;
  setArchived: (
    peerUuid: string,
    conversationUuid: string,
    archived: boolean,
  ) => Promise<boolean>;
  setMuted: (peerUuid: string, conversationUuid: string, muted: boolean) => Promise<void>;
};

function mirrorSnapshot() {
  const snap = session.getSnapshot();
  return {
    ownerUserUuid: snap.ownerUserUuid,
    state: snap.state,
    syncing: snap.syncing,
  };
}

export const useChatListOverlayStore = create<ChatListOverlayStore>((set) => {
  session.subscribe(() => set(mirrorSnapshot()));

  return {
    ...mirrorSnapshot(),
    hydrate: (userUuid) => session.hydrate(userUuid),
    refreshFromServer: () => session.refresh(),
    createFolder: (params) => session.createFolder(params),
    addPeerToEntity: (entityId, peerUuid) => session.addPeerToFolder(entityId, peerUuid),
    removeEntity: (entityId) => session.removeFolder(entityId),
    setArchived: (peerUuid, conversationUuid, archived) =>
      session.setArchived(peerUuid, conversationUuid, archived),
    setMuted: (peerUuid, conversationUuid, muted) =>
      session.setMuted(peerUuid, conversationUuid, muted),
  };
});
