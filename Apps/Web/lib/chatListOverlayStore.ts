/**
 * Оверлей списка чатов (Web): localStorage-кэш + shared session из client-core.
 */
"use client";

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
import { initWebApiClient } from "@/lib/apiClient";
import { useCallback, useSyncExternalStore } from "react";

/** v2: сброс локального кэша эпохи «папки только в localStorage». */
const KEY_PREFIX = "flora_chatListOverlay:v2:";

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

const session = createChatListOverlaySession({
  ensureHttp: () => initWebApiClient(),
  warn:
    process.env.NODE_ENV !== "production"
      ? (message, detail) => console.warn(message, detail)
      : undefined,
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

export function hydrateChatListOverlay(userUuid: string | null) {
  session.hydrate(userUuid);
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
