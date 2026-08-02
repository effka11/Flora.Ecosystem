/**
 * Chat list organizer (Web): localStorage cache + FSCP-ORG session (client-core).
 */
"use client";

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
import { initWebApiClient } from "@/lib/apiClient";
import { useCallback, useSyncExternalStore } from "react";

/** v1 FSCP-ORG decrypted cache (bumped from plaintext overlay v2). */
const KEY_PREFIX = "flora_chatOrganizer:v1:";

function storageKey(userUuid: string): string {
  return `${KEY_PREFIX}${userUuid.trim().toLowerCase()}`;
}

function readState(userUuid: string): ChatListOverlayState {
  if (typeof window === "undefined") return emptyChatListOverlayState();
  try {
    const raw = window.localStorage.getItem(storageKey(userUuid));
    if (!raw) return emptyChatListOverlayState();
    return parseChatListOverlayState(JSON.parse(raw) as unknown) ?? emptyChatListOverlayState();
  } catch {
    return emptyChatListOverlayState();
  }
}

function writeState(userUuid: string, state: ChatListOverlayState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(userUuid), JSON.stringify(state));
}

function asFscpPlaintext(state: ChatOrganizerPlaintext): FscpOrganizerStatePlaintext {
  return state as FscpOrganizerStatePlaintext;
}

const session = createChatOrganizerSession({
  ensureHttp: () => initWebApiClient(),
  warn:
    process.env.NODE_ENV !== "production"
      ? (message, detail) => console.warn(message, detail)
      : undefined,
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

export function hydrateChatListOverlay(userUuid: string | null) {
  session.hydrate(userUuid);
}

export function setChatListOverlayFscpKeys(keys: ChatOrganizerFscpKeys | null) {
  session.setKeys(keys);
}

export function refreshChatListOverlay(): void {
  void session.refresh();
}

export async function createChatListFolder(params: {
  icon: string;
  memberPeerUuids: readonly string[];
  label?: string;
}): Promise<ChatListCustomEntity | null> {
  return session.createFolder(params);
}

export async function addPeerToChatListFolder(entityId: string, peerUuid: string): Promise<void> {
  await session.addPeerToFolder(entityId, peerUuid);
}

export async function removeChatListFolder(entityId: string): Promise<void> {
  await session.removeFolder(entityId);
}

export async function setChatListArchived(
  peerUuid: string,
  conversationUuid: string,
  archived: boolean,
): Promise<boolean> {
  return session.setArchived(peerUuid, conversationUuid, archived);
}

export async function setChatListMuted(
  peerUuid: string,
  conversationUuid: string,
  muted: boolean,
): Promise<void> {
  await session.setMuted(peerUuid, conversationUuid, muted);
}

const SERVER_STATE = emptyChatListOverlayState();

function getClientState(): ChatListOverlayState {
  return session.getSnapshot().state;
}

function getServerState(): ChatListOverlayState {
  return SERVER_STATE;
}

export function useChatListOverlayState(): ChatListOverlayState {
  return useSyncExternalStore(session.subscribe, getClientState, getServerState);
}

export function useChatListOverlayHydrate(): (userUuid: string | null) => void {
  return useCallback((userUuid: string | null) => {
    hydrateChatListOverlay(userUuid);
  }, []);
}
