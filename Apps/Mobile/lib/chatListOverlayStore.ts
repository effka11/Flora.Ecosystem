/**
 * Chat list organizer (Mobile): MMKV cache + FSCP-ORG session (client-core).
 */
import {
  apiGetChatListOverlay,
  apiGetChatOrganizer,
  apiPutChatOrganizer,
} from "@flora/client-core/api";
import {
  buildFscpOrganizerWireEnvelope,
  decryptFscpOrganizerWireEnvelope,
  type FscpOrganizerStatePlaintext,
} from "@flora/client-core/fscp";
import {
  createChatOrganizerSession,
  emptyChatListOverlayState,
  parseChatListOverlayState,
  type ChatListCustomEntity,
  type ChatListOverlayState,
  type ChatOrganizerFscpKeys,
  type ChatOrganizerPlaintext,
} from "@flora/client-core/messaging";
import { create } from "zustand";
import { mmkv } from "@/lib/mmkv";

/** v1 FSCP-ORG decrypted cache (bumped from plaintext overlay v2). */
const KEY_PREFIX = "chatOrganizer:v1:";

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

function asFscpPlaintext(state: ChatOrganizerPlaintext): FscpOrganizerStatePlaintext {
  return state as FscpOrganizerStatePlaintext;
}

const session = createChatOrganizerSession({
  warn: __DEV__ ? (message, detail) => console.warn(message, detail) : undefined,
  http: {
    getBlob: apiGetChatOrganizer,
    putBlob: apiPutChatOrganizer,
    getPlaintextOverlay: apiGetChatListOverlay,
  },
  crypto: {
    async buildWire({ ownerUserUuid, revision, state, keys }) {
      return buildFscpOrganizerWireEnvelope({
        ownerUserUuid,
        revision,
        state: asFscpPlaintext(state),
        ownerAgreementPrivateKey: keys.agreementPrivateKey,
        ownerSigningPrivateKey: keys.signingPrivateKey,
      });
    },
    async decryptWire({ ownerUserUuid, wire, keys }) {
      const decrypted = await decryptFscpOrganizerWireEnvelope({
        wire,
        ownerUserUuid,
        agreementPrivateKey: keys.agreementPrivateKey,
      });
      return {
        state: decrypted.state as ChatOrganizerPlaintext,
        revision: decrypted.revision,
      };
    },
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
  setFscpKeys: (keys: ChatOrganizerFscpKeys | null) => void;
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
    setFscpKeys: (keys) => session.setKeys(keys),
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
