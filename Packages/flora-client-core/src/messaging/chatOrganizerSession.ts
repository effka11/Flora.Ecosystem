/**
 * FSCP-ORG chat organizer sync (Web + Mobile).
 * Crypto injected (keeps `@flora/client-core/messaging` free of libsodium).
 * Serial write queue — one in-flight PUT per owner (revision monotonicity).
 *
 * Archive/mute stay in the E2E blob; a best-effort mirror into
 * `user_conversation_flags` keeps `/unread-count` (server SoT for the nav badge)
 * from counting archived DM peers.
 */
import { dmConversationUuid } from "@flora/fscp";
import { ApiRequestError } from "../api/errors.js";
import {
  addPeerToChatListEntity,
  canArchiveChatListPeer,
  canCreateChatListFolder,
  chatListOverlayFromApi,
  CHAT_LIST_FOLDER_LABEL_MAX,
  countArchivedPeers,
  emptyChatListOverlayState,
  isChatListFolderIconName,
  isPeerArchived,
  newChatListUuidV7,
  removeChatListEntity,
  setPeerArchivedFlag,
  setPeerMutedFlag,
  type ChatListCustomEntity,
  type ChatListOverlayState,
} from "./chatListFolders.js";
import {
  mergeOverlayForMigrate,
  organizerPlaintextToOverlayState,
  overlayStateToOrganizerPlaintext,
  type ChatOrganizerPlaintext,
} from "./chatOrganizerMap.js";

export type ChatOrganizerFscpKeys = {
  agreementPrivateKey: Uint8Array;
  signingPrivateKey: Uint8Array;
};

export type ChatOrganizerCrypto = {
  buildWire: (params: {
    ownerUserUuid: string;
    revision: number;
    state: ChatOrganizerPlaintext;
    keys: ChatOrganizerFscpKeys;
  }) => Promise<string>;
  decryptWire: (params: {
    ownerUserUuid: string;
    wire: string;
    keys: ChatOrganizerFscpKeys;
  }) => Promise<{ state: ChatOrganizerPlaintext; revision: number }>;
};

export type ChatOrganizerHttp = {
  getBlob: () => Promise<{ revision: number; wire: string; updatedAt: string } | null>;
  putBlob: (wire: string) => Promise<void>;
  /** Legacy plaintext overlay — migrate only (+ archive-flag reconcile). */
  getPlaintextOverlay?: () => Promise<unknown>;
  /**
   * Mirror archive into server `user_conversation_flags` so unread badge excludes
   * archived peers. Optional — tests / offline can omit.
   */
  setConversationArchived?: (
    conversationUuid: string,
    otherUserUuid: string,
    archived: boolean,
  ) => Promise<void>;
};

export type ChatOrganizerPersistence = {
  read: (ownerUserUuid: string) => ChatListOverlayState;
  write: (ownerUserUuid: string, state: ChatListOverlayState) => void;
};

export type ChatOrganizerSnapshot = {
  ownerUserUuid: string | null;
  state: ChatListOverlayState;
  syncing: boolean;
  keysReady: boolean;
  decryptError: string | null;
};

export type ChatOrganizerSession = {
  getSnapshot: () => ChatOrganizerSnapshot;
  subscribe: (listener: () => void) => () => void;
  hydrate: (userUuid: string | null) => void;
  setKeys: (keys: ChatOrganizerFscpKeys | null) => void;
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

type Intent =
  | { kind: "createFolder"; entity: ChatListCustomEntity }
  | { kind: "addPeer"; entityId: string; peerUuid: string }
  | { kind: "removeFolder"; entityId: string; removed?: ChatListCustomEntity }
  | {
      kind: "setArchived";
      peerUuid: string;
      conversationUuid: string;
      archived: boolean;
    }
  | {
      kind: "setMuted";
      peerUuid: string;
      conversationUuid: string;
      muted: boolean;
    };

const MAX_409_RETRIES = 3;

function applyIntent(state: ChatListOverlayState, intent: Intent): ChatListOverlayState | null {
  switch (intent.kind) {
    case "createFolder": {
      if (state.entities.some((e) => e.id === intent.entity.id)) {
        return {
          ...state,
          entities: state.entities.map((e) =>
            e.id === intent.entity.id ? intent.entity : e,
          ),
        };
      }
      return { ...state, entities: [...state.entities, intent.entity] };
    }
    case "addPeer": {
      const entities = addPeerToChatListEntity(
        state.entities,
        intent.entityId,
        intent.peerUuid,
      );
      if (entities === state.entities) return null;
      return { ...state, entities };
    }
    case "removeFolder": {
      const entities = removeChatListEntity(state.entities, intent.entityId);
      if (entities === state.entities) return null;
      return { ...state, entities };
    }
    case "setArchived": {
      if (intent.archived) {
        const archivedCount = countArchivedPeers(state.archivedByPeer);
        if (!canArchiveChatListPeer(archivedCount, state.entities.length)) return null;
      }
      const archivedByPeer = setPeerArchivedFlag(
        state.archivedByPeer,
        intent.peerUuid,
        intent.archived,
      );
      const conv = intent.conversationUuid.trim();
      const archivedByConversation = conv
        ? setPeerArchivedFlag(
            state.archivedByConversation ?? {},
            conv,
            intent.archived,
          )
        : (state.archivedByConversation ?? {});
      if (
        archivedByPeer === state.archivedByPeer &&
        archivedByConversation === (state.archivedByConversation ?? {})
      ) {
        return state;
      }
      return { ...state, archivedByPeer, archivedByConversation };
    }
    case "setMuted": {
      const mutedByPeer = setPeerMutedFlag(
        state.mutedByPeer,
        intent.peerUuid,
        intent.muted,
      );
      const conv = intent.conversationUuid.trim();
      const mutedByConversation = conv
        ? setPeerMutedFlag(state.mutedByConversation ?? {}, conv, intent.muted)
        : (state.mutedByConversation ?? {});
      if (
        mutedByPeer === state.mutedByPeer &&
        mutedByConversation === (state.mutedByConversation ?? {})
      ) {
        return state;
      }
      return { ...state, mutedByPeer, mutedByConversation };
    }
    default:
      return null;
  }
}

/** Best-effort undo of a single intent against live state (does not wipe later intents). */
function revertIntent(state: ChatListOverlayState, intent: Intent): ChatListOverlayState {
  switch (intent.kind) {
    case "createFolder":
      return {
        ...state,
        entities: state.entities.filter((e) => e.id !== intent.entity.id),
      };
    case "addPeer": {
      const entities = state.entities.map((e) => {
        if (e.id !== intent.entityId) return e;
        return {
          ...e,
          memberPeerUuids: e.memberPeerUuids.filter((p) => p !== intent.peerUuid),
        };
      });
      return { ...state, entities };
    }
    case "removeFolder":
      if (!intent.removed) return state;
      if (state.entities.some((e) => e.id === intent.removed!.id)) return state;
      return {
        ...state,
        entities: [...state.entities, intent.removed],
      };
    case "setArchived":
      return (
        applyIntent(state, {
          ...intent,
          archived: !intent.archived,
        }) ?? state
      );
    case "setMuted":
      return (
        applyIntent(state, {
          ...intent,
          muted: !intent.muted,
        }) ?? state
      );
    default:
      return state;
  }
}

export function createChatOrganizerSession(options: {
  http: ChatOrganizerHttp;
  crypto: ChatOrganizerCrypto;
  persistence: ChatOrganizerPersistence;
  ensureHttp?: () => void;
  warn?: (message: string, detail?: unknown) => void;
}): ChatOrganizerSession {
  const { http, crypto, persistence, ensureHttp, warn } = options;

  let snapshot: ChatOrganizerSnapshot = {
    ownerUserUuid: null,
    state: emptyChatListOverlayState(),
    syncing: false,
    keysReady: false,
    decryptError: null,
  };
  let keys: ChatOrganizerFscpKeys | null = null;
  let refreshSeq = 0;
  /** One reconcile pass per owner hydrate (avoid hammering archive routes). */
  let archiveFlagsReconciledForOwner: string | null = null;
  const listeners = new Set<() => void>();

  /** Serializes all server writes for this session. */
  let writeChain: Promise<void> = Promise.resolve();

  function emit() {
    for (const listener of listeners) listener();
  }

  function getSnapshot(): ChatOrganizerSnapshot {
    return snapshot;
  }

  function setLocal(partial: Partial<ChatOrganizerSnapshot>) {
    const next: ChatOrganizerSnapshot = {
      ownerUserUuid:
        partial.ownerUserUuid !== undefined
          ? partial.ownerUserUuid
          : snapshot.ownerUserUuid,
      state: partial.state !== undefined ? partial.state : snapshot.state,
      syncing: partial.syncing !== undefined ? partial.syncing : snapshot.syncing,
      keysReady:
        partial.keysReady !== undefined ? partial.keysReady : snapshot.keysReady,
      decryptError:
        partial.decryptError !== undefined
          ? partial.decryptError
          : snapshot.decryptError,
    };
    if (
      next.ownerUserUuid === snapshot.ownerUserUuid &&
      next.state === snapshot.state &&
      next.syncing === snapshot.syncing &&
      next.keysReady === snapshot.keysReady &&
      next.decryptError === snapshot.decryptError
    ) {
      return;
    }
    snapshot = next;
    emit();
  }

  function persist(owner: string, next: ChatListOverlayState) {
    persistence.write(owner, next);
    setLocal({ state: next });
  }

  async function mirrorConversationArchived(
    conversationUuid: string,
    peerUuid: string,
    archived: boolean,
  ): Promise<void> {
    if (!http.setConversationArchived) return;
    try {
      ensureHttp?.();
      await http.setConversationArchived(conversationUuid, peerUuid, archived);
    } catch (e: unknown) {
      warn?.("[chatOrganizer] archive flag mirror failed", e);
    }
  }

  /**
   * Align server archive flags with E2E organizer state (badge SQL reads flags).
   * Runs at most once per hydrated owner.
   */
  async function reconcileServerArchiveFlags(
    owner: string,
    state: ChatListOverlayState,
  ): Promise<void> {
    if (!http.setConversationArchived) return;
    if (archiveFlagsReconciledForOwner === owner) return;
    archiveFlagsReconciledForOwner = owner;

    let serverArchived = new Set<string>();
    if (http.getPlaintextOverlay) {
      try {
        ensureHttp?.();
        const raw = await http.getPlaintextOverlay();
        const fromApi = chatListOverlayFromApi(raw);
        if (fromApi) {
          serverArchived = new Set(Object.keys(fromApi.archivedByPeer));
        }
      } catch (e: unknown) {
        warn?.("[chatOrganizer] archive reconcile: overlay read failed", e);
      }
    }

    const desired = new Set(Object.keys(state.archivedByPeer));
    for (const peer of desired) {
      if (serverArchived.has(peer)) continue;
      await mirrorConversationArchived(dmConversationUuid(owner, peer), peer, true);
    }
    for (const peer of serverArchived) {
      if (desired.has(peer)) continue;
      await mirrorConversationArchived(dmConversationUuid(owner, peer), peer, false);
    }
  }

  function enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = writeChain.then(task, task);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function putState(
    owner: string,
    baseRevision: number,
    state: ChatListOverlayState,
    intent: Intent | null,
  ): Promise<ChatListOverlayState> {
    if (!keys) throw new Error("FSCP keys not ready");
    let working = state;
    let revision = baseRevision;
    for (let attempt = 0; attempt <= MAX_409_RETRIES; attempt++) {
      const nextRevision = revision + 1;
      const plain = overlayStateToOrganizerPlaintext(working);
      const wire = await crypto.buildWire({
        ownerUserUuid: owner,
        revision: nextRevision,
        state: plain,
        keys,
      });
      try {
        ensureHttp?.();
        await http.putBlob(wire);
        return {
          ...working,
          revision: nextRevision,
          migratedToOrg: true,
        };
      } catch (e: unknown) {
        if (!(e instanceof ApiRequestError) || e.status !== 409) throw e;
        if (attempt === MAX_409_RETRIES) throw e;
        ensureHttp?.();
        const blob = await http.getBlob();
        if (!blob) {
          // Blob disappeared mid-conflict — never rewrite as rev1 (bypasses
          // migrate/no-reseed guards). Surface and stop.
          throw new ApiRequestError(
            409,
            "Chat organizer conflict: blob missing on server after 409.",
          );
        }
        const decrypted = await crypto.decryptWire({
          ownerUserUuid: owner,
          wire: blob.wire,
          keys,
        });
        // Reject full rollback (spec §2.3): older remote must not overwrite newer local.
        if (
          Number.isInteger(revision) &&
          revision >= 1 &&
          decrypted.revision < revision
        ) {
          throw new ApiRequestError(
            409,
            `Chat organizer rollback rejected: remote rev ${decrypted.revision} < local ${revision}.`,
          );
        }
        working = organizerPlaintextToOverlayState(decrypted.state, {
          revision: decrypted.revision,
          migratedToOrg: true,
        });
        revision = decrypted.revision;
        if (intent) {
          const reapplied = applyIntent(working, intent);
          if (reapplied) working = reapplied;
        }
      }
    }
    throw new Error("chat organizer: 409 retries exhausted");
  }

  async function syncFromServer(): Promise<void> {
    const owner = snapshot.ownerUserUuid;
    if (!owner || !keys) return;
    const seq = ++refreshSeq;
    setLocal({ syncing: true, decryptError: null });
    try {
      ensureHttp?.();
      const blob = await http.getBlob();
      if (snapshot.ownerUserUuid !== owner || seq !== refreshSeq) return;

      if (blob) {
        try {
          const decrypted = await crypto.decryptWire({
            ownerUserUuid: owner,
            wire: blob.wire,
            keys,
          });
          if (snapshot.ownerUserUuid !== owner || seq !== refreshSeq) return;
          const localRev = snapshot.state.revision ?? 0;
          if (localRev >= 1 && decrypted.revision < localRev) {
            warn?.(
              "[chatOrganizer] rejected older remote revision",
              { local: localRev, remote: decrypted.revision },
            );
            setLocal({
              decryptError: `Chat organizer rollback rejected: remote rev ${decrypted.revision} < local ${localRev}.`,
            });
            return;
          }
          const nextState = organizerPlaintextToOverlayState(decrypted.state, {
            revision: decrypted.revision,
            migratedToOrg: true,
          });
          persist(owner, nextState);
          void reconcileServerArchiveFlags(owner, nextState);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          warn?.("[chatOrganizer] decrypt failed", e);
          setLocal({ decryptError: msg });
          // Never remigrate over an existing blob.
        }
        return;
      }

      // 404 — first-time migrate only. If we already migrated, do NOT re-seed
      // (avoids resurrecting stale plaintext / wiping another device's history).
      const local = persistence.read(owner);
      if (local.migratedToOrg || (local.revision ?? 0) > 0) {
        warn?.(
          "[chatOrganizer] server blob missing but local migrated — keeping local cache, no re-seed",
        );
        setLocal({
          decryptError:
            "Chat organizer blob missing on server (local cache kept).",
        });
        return;
      }

      let seed = local;
      if (http.getPlaintextOverlay) {
        try {
          const raw = await http.getPlaintextOverlay();
          const fromApi = chatListOverlayFromApi(raw);
          seed = mergeOverlayForMigrate(local, fromApi);
        } catch (e: unknown) {
          warn?.("[chatOrganizer] plaintext overlay migrate read failed", e);
        }
      }

      await enqueueWrite(async () => {
        if (snapshot.ownerUserUuid !== owner || !keys) return;
        try {
          const saved = await putState(owner, 0, { ...seed, revision: 0 }, null);
          if (snapshot.ownerUserUuid === owner) persist(owner, saved);
        } catch (e: unknown) {
          if (e instanceof ApiRequestError && e.status === 409) {
            // Another device migrated — pull
            const again = await http.getBlob();
            if (again && keys) {
              const decrypted = await crypto.decryptWire({
                ownerUserUuid: owner,
                wire: again.wire,
                keys,
              });
              if (snapshot.ownerUserUuid === owner) {
                persist(
                  owner,
                  organizerPlaintextToOverlayState(decrypted.state, {
                    revision: decrypted.revision,
                    migratedToOrg: true,
                  }),
                );
              }
            }
            return;
          }
          throw e;
        }
      });
    } catch (e: unknown) {
      warn?.("[chatOrganizer] refresh failed", e);
    } finally {
      if (snapshot.ownerUserUuid === owner && seq === refreshSeq) {
        setLocal({ syncing: false });
      }
    }
  }

  function hydrate(userUuid: string | null) {
    const owner = userUuid?.trim() || null;
    if (snapshot.ownerUserUuid === owner && owner) {
      if (keys) void syncFromServer();
      return;
    }
    archiveFlagsReconciledForOwner = null;
    setLocal({
      ownerUserUuid: owner,
      state: owner ? persistence.read(owner) : emptyChatListOverlayState(),
      decryptError: null,
    });
    if (owner && keys) void syncFromServer();
  }

  function setKeys(next: ChatOrganizerFscpKeys | null) {
    keys = next;
    setLocal({ keysReady: next != null });
    if (next && snapshot.ownerUserUuid) void syncFromServer();
  }

  async function mutateWithIntent(
    intent: Intent,
    optimistic: ChatListOverlayState,
  ): Promise<void> {
    const owner = snapshot.ownerUserUuid;
    if (!owner || !keys) return;
    // Optimistic UI immediately; failure reverts only THIS intent on live state
    // so a later queued mutate is not wiped by rolling back to an old snapshot.
    persist(owner, optimistic);
    try {
      await enqueueWrite(async () => {
        if (snapshot.ownerUserUuid !== owner || !keys) return;
        // Re-apply intent on live state (prior queue items may have advanced revision).
        const live = snapshot.state;
        const withIntent = applyIntent(live, intent) ?? live;
        const baseRev = withIntent.revision ?? 0;
        try {
          const saved = await putState(owner, baseRev, withIntent, intent);
          if (snapshot.ownerUserUuid === owner) persist(owner, saved);
        } catch (e: unknown) {
          warn?.("[chatOrganizer] mutate failed", e);
          if (snapshot.ownerUserUuid === owner) {
            persist(owner, revertIntent(snapshot.state, intent));
          }
          throw e;
        }
      });
    } catch {
      // Error already handled inside queue (intent-local revert). Swallow so
      // callers don't see unhandled rejection; chain continues for later tasks.
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
    setKeys,
    refresh: () => syncFromServer(),
    async createFolder(params) {
      const owner = snapshot.ownerUserUuid;
      if (!owner || !keys) return null;
      const archivedCount = countArchivedPeers(snapshot.state.archivedByPeer);
      if (!canCreateChatListFolder(archivedCount, snapshot.state.entities.length)) {
        warn?.("[chatOrganizer] create blocked: folder icon limit");
        return null;
      }
      if (!isChatListFolderIconName(params.icon)) {
        warn?.("[chatOrganizer] create blocked: bad icon", params.icon);
        return null;
      }
      const entity: ChatListCustomEntity = {
        id: newChatListUuidV7(),
        kind: "folder",
        label: (params.label?.trim() || "Папка").slice(0, CHAT_LIST_FOLDER_LABEL_MAX),
        icon: params.icon,
        memberPeerUuids: [...params.memberPeerUuids],
        memberConversationUuids: [],
        createdAtMs: Date.now(),
      };
      const intent: Intent = { kind: "createFolder", entity };
      const next = applyIntent(snapshot.state, intent);
      if (!next) return null;
      await mutateWithIntent(intent, next);
      return snapshot.state.entities.find((e) => e.id === entity.id) ?? entity;
    },
    async addPeerToFolder(entityId, peerUuid) {
      const intent: Intent = { kind: "addPeer", entityId, peerUuid };
      const next = applyIntent(snapshot.state, intent);
      if (!next) return;
      await mutateWithIntent(intent, next);
    },
    async removeFolder(entityId) {
      const removed = snapshot.state.entities.find((e) => e.id === entityId);
      const intent: Intent = { kind: "removeFolder", entityId, removed };
      const next = applyIntent(snapshot.state, intent);
      if (!next) return;
      await mutateWithIntent(intent, next);
    },
    async setArchived(peerUuid, conversationUuid, archived) {
      if (!peerUuid.trim()) return false;
      const peer = peerUuid.trim();
      const conv = conversationUuid.trim();
      const intent: Intent = {
        kind: "setArchived",
        peerUuid: peer,
        conversationUuid: conv,
        archived,
      };
      const next = applyIntent(snapshot.state, intent);
      if (!next) return false;
      if (next === snapshot.state) {
        // Already in desired E2E state — still mirror flags (badge SQL).
        if (conv) await mirrorConversationArchived(conv, peer, archived);
        return true;
      }
      await mutateWithIntent(intent, next);
      const ok = isPeerArchived(peer, snapshot.state.archivedByPeer) === archived;
      if (ok && conv) await mirrorConversationArchived(conv, peer, archived);
      return ok;
    },
    async setMuted(peerUuid, conversationUuid, muted) {
      if (!peerUuid.trim()) return;
      const intent: Intent = {
        kind: "setMuted",
        peerUuid,
        conversationUuid,
        muted,
      };
      const next = applyIntent(snapshot.state, intent);
      if (!next || next === snapshot.state) return;
      await mutateWithIntent(intent, next);
    },
  };
}
