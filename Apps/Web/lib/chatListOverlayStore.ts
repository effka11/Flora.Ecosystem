/**
 * Оверлей списка чатов (Web): localStorage-кэш + Messaging API (без FSCP).
 * SoT — сервер; кэш только офлайн. Reconcile — latest-wins (не mutationEpoch).
 * HTTP — `@/lib/authorizedFetch`.
 */
"use client";

import {
  authDelete,
  authGetJson,
  authPostJson,
} from "@/lib/authorizedFetch";
import { initWebApiClient } from "@/lib/apiClient";
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
import { useCallback, useSyncExternalStore } from "react";

/** v2: сброс локального кэша эпохи «папки только в localStorage». */
const KEY_PREFIX = "flora_chatListOverlay:v2:";

type Snapshot = {
  ownerUserUuid: string | null;
  state: ChatListOverlayState;
  syncing: boolean;
};

let snapshot: Snapshot = {
  ownerUserUuid: null,
  state: emptyChatListOverlayState(),
  syncing: false,
};

/** Монотонный номер GET; применяется только последний. */
let refreshSeq = 0;

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function storageKey(userUuid: string): string {
  return `${KEY_PREFIX}${userUuid.trim().toLowerCase()}`;
}

function readState(userUuid: string | null | undefined): ChatListOverlayState {
  if (!userUuid?.trim() || typeof window === "undefined") return emptyChatListOverlayState();
  try {
    const raw = window.localStorage.getItem(storageKey(userUuid));
    if (!raw) return emptyChatListOverlayState();
    const parsed = parseChatListOverlayState(JSON.parse(raw) as unknown);
    return parsed ?? emptyChatListOverlayState();
  } catch {
    return emptyChatListOverlayState();
  }
}

function writeState(userUuid: string, state: ChatListOverlayState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(userUuid), JSON.stringify(state));
}

function setSnapshot(partial: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...partial };
  emit();
}

function conversationPeerQs(otherUserUuid: string): string {
  return `?otherUserUuid=${encodeURIComponent(otherUserUuid.trim())}`;
}

async function apiGetOverlay(): Promise<unknown> {
  initWebApiClient();
  return authGetJson("/api/messaging/chat-list-overlay");
}

async function apiCreateFolder(body: {
  kind: "folder" | "group";
  label: string;
  icon?: string;
  avatarUri?: string | null;
  memberPeerUuids?: readonly string[];
}): Promise<unknown> {
  initWebApiClient();
  return authPostJson("/api/messaging/chat-folders", {
    kind: body.kind,
    label: body.label,
    icon: body.icon,
    avatarUri: body.avatarUri ?? undefined,
    memberPeerUuids: [...(body.memberPeerUuids ?? [])],
  });
}

async function apiDeleteFolder(folderId: string): Promise<void> {
  initWebApiClient();
  await authDelete(`/api/messaging/chat-folders/${encodeURIComponent(folderId.trim())}`);
}

async function apiAddMember(folderId: string, otherUserUuid: string): Promise<void> {
  initWebApiClient();
  await authPostJson(
    `/api/messaging/chat-folders/${encodeURIComponent(folderId.trim())}/members`,
    { otherUserUuid: otherUserUuid.trim() },
  );
}

async function apiArchive(conversationUuid: string, otherUserUuid: string): Promise<void> {
  initWebApiClient();
  await authPostJson(
    `/api/messaging/conversations/${encodeURIComponent(conversationUuid.trim())}/archive${conversationPeerQs(otherUserUuid)}`,
    {},
  );
}

async function apiUnarchive(conversationUuid: string, otherUserUuid: string): Promise<void> {
  initWebApiClient();
  await authPostJson(
    `/api/messaging/conversations/${encodeURIComponent(conversationUuid.trim())}/unarchive${conversationPeerQs(otherUserUuid)}`,
    {},
  );
}

async function apiMute(conversationUuid: string, otherUserUuid: string): Promise<void> {
  initWebApiClient();
  await authPostJson(
    `/api/messaging/conversations/${encodeURIComponent(conversationUuid.trim())}/mute${conversationPeerQs(otherUserUuid)}`,
    {},
  );
}

async function apiUnmute(conversationUuid: string, otherUserUuid: string): Promise<void> {
  initWebApiClient();
  await authPostJson(
    `/api/messaging/conversations/${encodeURIComponent(conversationUuid.trim())}/unmute${conversationPeerQs(otherUserUuid)}`,
    {},
  );
}

async function refreshFromServer() {
  const owner = snapshot.ownerUserUuid;
  if (!owner) return;
  const seq = ++refreshSeq;
  setSnapshot({ syncing: true });
  try {
    const raw = await apiGetOverlay();
    const next = chatListOverlayFromApi(raw);
    if (!next) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[chatListOverlay] GET ok but parse failed", raw);
      }
      return;
    }
    if (snapshot.ownerUserUuid !== owner || seq !== refreshSeq) return;
    writeState(owner, next);
    setSnapshot({ state: next });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[chatListOverlay] refresh failed", error);
    }
  } finally {
    if (snapshot.ownerUserUuid === owner && seq === refreshSeq) {
      setSnapshot({ syncing: false });
    }
  }
}

export function hydrateChatListOverlay(userUuid: string | null) {
  const owner = userUuid?.trim() || null;
  if (snapshot.ownerUserUuid === owner && owner) {
    void refreshFromServer();
    return;
  }
  setSnapshot({
    ownerUserUuid: owner,
    state: readState(owner),
  });
  if (owner) void refreshFromServer();
}

/** Принудительный re-fetch (после загрузки чатов / focus / visibility). */
export function refreshChatListOverlay(): void {
  if (!snapshot.ownerUserUuid) return;
  void refreshFromServer();
}

export async function createChatListFolder(params: {
  icon: string;
  memberPeerUuids: readonly string[];
  label?: string;
}): Promise<ChatListCustomEntity | null> {
  const owner = snapshot.ownerUserUuid;
  if (!owner) return null;
  try {
    const raw = await apiCreateFolder({
      kind: "folder",
      label: (params.label?.trim() || "Папка").slice(0, 40),
      icon: params.icon,
      memberPeerUuids: params.memberPeerUuids,
    });
    const entity = chatListEntityFromApi(raw);
    if (!entity) {
      await refreshFromServer();
      return null;
    }
    const state: ChatListOverlayState = {
      ...snapshot.state,
      entities: [...snapshot.state.entities.filter((e) => e.id !== entity.id), entity],
    };
    writeState(owner, state);
    setSnapshot({ state });
    await refreshFromServer();
    return snapshot.state.entities.find((e) => e.id === entity.id) ?? entity;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[chatListOverlay] create failed", error);
    }
    return null;
  }
}

export async function addPeerToChatListFolder(entityId: string, peerUuid: string): Promise<void> {
  const owner = snapshot.ownerUserUuid;
  if (!owner) return;
  const prev = snapshot.state;
  const entities = addPeerToChatListEntity(prev.entities, entityId, peerUuid);
  if (entities === prev.entities) return;
  const state = { ...prev, entities };
  writeState(owner, state);
  setSnapshot({ state });
  try {
    await apiAddMember(entityId, peerUuid);
    await refreshFromServer();
  } catch {
    writeState(owner, prev);
    setSnapshot({ state: prev });
  }
}

export async function removeChatListFolder(entityId: string): Promise<void> {
  const owner = snapshot.ownerUserUuid;
  if (!owner) return;
  const prev = snapshot.state;
  const entities = removeChatListEntity(prev.entities, entityId);
  if (entities === prev.entities) return;
  const state = { ...prev, entities };
  writeState(owner, state);
  setSnapshot({ state });
  try {
    await apiDeleteFolder(entityId);
    await refreshFromServer();
  } catch {
    writeState(owner, prev);
    setSnapshot({ state: prev });
  }
}

export async function setChatListArchived(
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
  const state = { ...prev, archivedByPeer };
  writeState(owner, state);
  setSnapshot({ state });
  try {
    if (archived) await apiArchive(conversationUuid, peerUuid);
    else await apiUnarchive(conversationUuid, peerUuid);
    await refreshFromServer();
    return true;
  } catch {
    writeState(owner, prev);
    setSnapshot({ state: prev });
    return false;
  }
}

export async function setChatListMuted(
  peerUuid: string,
  conversationUuid: string,
  muted: boolean,
): Promise<void> {
  const owner = snapshot.ownerUserUuid;
  if (!owner || !peerUuid.trim() || !conversationUuid.trim()) return;
  const prev = snapshot.state;
  const mutedByPeer = setPeerMutedFlag(prev.mutedByPeer, peerUuid, muted);
  if (mutedByPeer === prev.mutedByPeer) return;
  const state = { ...prev, mutedByPeer };
  writeState(owner, state);
  setSnapshot({ state });
  try {
    if (muted) await apiMute(conversationUuid, peerUuid);
    else await apiUnmute(conversationUuid, peerUuid);
    await refreshFromServer();
  } catch {
    writeState(owner, prev);
    setSnapshot({ state: prev });
  }
}

export function pruneChatListUnknownPeers(knownPeerUuids: ReadonlySet<string>): void {
  const owner = snapshot.ownerUserUuid;
  if (!owner) return;
  const archivedByPeer = pruneArchivedPeers(snapshot.state.archivedByPeer, knownPeerUuids);
  const mutedByPeer = pruneArchivedPeers(snapshot.state.mutedByPeer, knownPeerUuids);
  if (
    archivedByPeer === snapshot.state.archivedByPeer &&
    mutedByPeer === snapshot.state.mutedByPeer
  ) {
    return;
  }
  const state = { ...snapshot.state, archivedByPeer, mutedByPeer };
  writeState(owner, state);
  setSnapshot({ state });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

function getServerSnapshot(): Snapshot {
  return {
    ownerUserUuid: null,
    state: emptyChatListOverlayState(),
    syncing: false,
  };
}

export function useChatListOverlayState(): ChatListOverlayState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot).state;
}

export function useChatListOverlayHydrate(): (userUuid: string | null) => void {
  return useCallback((userUuid: string | null) => {
    hydrateChatListOverlay(userUuid);
  }, []);
}
