/**
 * Система папок/групп списка чатов (клиентский слой).
 * Portable: Apps/Mobile и Apps/Web используют одни правила видимости/фильтрации.
 *
 * Порядок в UI (слева направо у правого края): пользовательские → Архив → «+».
 * SoT — Messaging HTTP (`/api/messaging/chat-list-overlay`, folders, archive/mute);
 * Apps кэшируют оверлей локально (MMKV и т.п.). Без FSCP.
 */

/** Системный id архива — всегда непосредственно слева от «+». */
export const CHAT_LIST_ARCHIVE_FOLDER_ID = "archived" as const;

/** Макс. иконок папок в ряду (пользовательские + Архив). Кнопка «+» не входит. */
export const CHAT_LIST_MAX_FOLDER_ICONS = 3;

export type ChatListSystemFolderId = typeof CHAT_LIST_ARCHIVE_FOLDER_ID;

/** `"all"` — основной список; `"archived"` — системная папка; иначе id пользовательской. */
export type ChatListFolderId = "all" | ChatListSystemFolderId | (string & {});

export type ChatListFolderDef = {
  id: Exclude<ChatListFolderId, "all">;
  label: string;
  kind?: "folder" | "group";
  /** Ionicon name для папки. */
  icon?: string;
  /** Локальный URI аватара группы (пока без серверного ассета). */
  avatarUri?: string | null;
};

export type ChatListCustomEntity = {
  id: string;
  kind: "folder" | "group";
  label: string;
  icon?: string;
  avatarUri?: string | null;
  memberPeerUuids: string[];
  createdAtMs: number;
};

export type ChatListOverlayState = {
  v: 1;
  entities: ChatListCustomEntity[];
  archivedByPeer: Record<string, true>;
  mutedByPeer: Record<string, true>;
};

/** Папки, которые показываются в UI (не включая основной список «все»). */
export const CHAT_LIST_FOLDER_ARCHIVE: ChatListFolderDef = {
  id: CHAT_LIST_ARCHIVE_FOLDER_ID,
  label: "Архив",
  kind: "folder",
};

export function emptyChatListOverlayState(): ChatListOverlayState {
  return {
    v: 1,
    entities: [],
    archivedByPeer: {},
    mutedByPeer: {},
  };
}

export function newChatListEntityId(kind: "folder" | "group"): string {
  const prefix = kind === "folder" ? "fld" : "grp";
  const rand =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${rand}`;
}

export function createChatListFolderEntity(params: {
  label?: string;
  icon: string;
  memberPeerUuids: readonly string[];
  nowMs?: number;
}): ChatListCustomEntity {
  const members = uniquePeerUuids(params.memberPeerUuids);
  return {
    id: newChatListEntityId("folder"),
    kind: "folder",
    label: (params.label?.trim() || "Папка").slice(0, 40),
    icon: params.icon,
    memberPeerUuids: members,
    createdAtMs: params.nowMs ?? Date.now(),
  };
}

export function createChatListGroupEntity(params: {
  name: string;
  avatarUri?: string | null;
  memberPeerUuids: readonly string[];
  nowMs?: number;
}): ChatListCustomEntity {
  const name = params.name.trim();
  if (!name) throw new Error("Укажите название группы.");
  const members = uniquePeerUuids(params.memberPeerUuids);
  if (members.length === 0) throw new Error("Добавьте хотя бы одного участника.");
  return {
    id: newChatListEntityId("group"),
    kind: "group",
    label: name.slice(0, 80),
    avatarUri: params.avatarUri ?? null,
    memberPeerUuids: members,
    createdAtMs: params.nowMs ?? Date.now(),
  };
}

export function entitiesToFolderDefs(
  entities: readonly ChatListCustomEntity[],
): ChatListFolderDef[] {
  return entities.map((e) => ({
    id: e.id,
    label: e.label,
    kind: e.kind,
    icon: e.icon,
    avatarUri: e.avatarUri,
  }));
}

export function membershipByEntityId(
  entities: readonly ChatListCustomEntity[],
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const e of entities) out[e.id] = e.memberPeerUuids;
  return out;
}

export function addPeerToChatListEntity(
  entities: readonly ChatListCustomEntity[],
  entityId: string,
  peerUuid: string,
): ChatListCustomEntity[] {
  const peer = peerUuid.trim();
  if (!peer) return entities as ChatListCustomEntity[];
  let changed = false;
  const next = entities.map((e) => {
    if (e.id !== entityId) return e;
    if (e.memberPeerUuids.includes(peer)) return e;
    changed = true;
    return { ...e, memberPeerUuids: [...e.memberPeerUuids, peer] };
  });
  return changed ? next : (entities as ChatListCustomEntity[]);
}

export function removeChatListEntity(
  entities: readonly ChatListCustomEntity[],
  entityId: string,
): ChatListCustomEntity[] {
  const next = entities.filter((e) => e.id !== entityId);
  return next.length === entities.length ? (entities as ChatListCustomEntity[]) : next;
}

export function countArchivedPeers(
  archivedByPeer: Readonly<Record<string, true>>,
  knownPeerUuids?: ReadonlySet<string>,
): number {
  const keys = Object.keys(archivedByPeer);
  if (!knownPeerUuids) return keys.length;
  return keys.reduce((n, uuid) => (knownPeerUuids.has(uuid) ? n + 1 : n), 0);
}

/**
 * Порядок папок: все не-архивные слева, архив — крайний справа (перед «+»).
 * Дубликаты id отбрасываются; архив из customFolders не учитывается (берётся системный).
 */
export function orderChatListFolders(
  folders: readonly ChatListFolderDef[],
): ChatListFolderDef[] {
  const seen = new Set<string>();
  const custom: ChatListFolderDef[] = [];
  let archive: ChatListFolderDef | null = null;

  for (const folder of folders) {
    if (folder.id === CHAT_LIST_ARCHIVE_FOLDER_ID) {
      archive = CHAT_LIST_FOLDER_ARCHIVE;
      continue;
    }
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    custom.push(folder);
  }

  return archive ? [...custom, archive] : custom;
}

/** Сколько пользовательских папок можно показать при данном archive и лимите иконок. */
export function maxCustomChatListFolders(
  archivedCount: number,
  maxIcons: number = CHAT_LIST_MAX_FOLDER_ICONS,
): number {
  const reserveArchive = archivedCount > 0 ? 1 : 0;
  return Math.max(0, maxIcons - reserveArchive);
}

/** Можно ли создать ещё одну пользовательскую папку (лимит иконок с учётом Архива). */
export function canCreateChatListFolder(
  archivedCount: number,
  customFolderCount: number,
  maxIcons: number = CHAT_LIST_MAX_FOLDER_ICONS,
): boolean {
  return customFolderCount < maxCustomChatListFolders(archivedCount, maxIcons);
}

/**
 * Какие папки показывать справа от фильтра.
 * @param archivedCount — если > 0, в конец добавляется Архив (слева от «+»).
 * @param customFolders — пользовательские папки/группы; всегда левее архива.
 * Не больше {@link CHAT_LIST_MAX_FOLDER_ICONS} иконок; Архив всегда сохраняется в лимите.
 */
export function listVisibleChatFolders(
  archivedCount: number,
  customFolders: readonly ChatListFolderDef[] = [],
  maxIcons: number = CHAT_LIST_MAX_FOLDER_ICONS,
): readonly ChatListFolderDef[] {
  const customCap = maxCustomChatListFolders(archivedCount, maxIcons);
  const cappedCustom = customFolders.slice(0, customCap);
  const folders: ChatListFolderDef[] = [...cappedCustom];
  if (archivedCount > 0) folders.push(CHAT_LIST_FOLDER_ARCHIVE);
  return orderChatListFolders(folders);
}

/**
 * Страницы горизонтального pager списка чатов: «все» всегда слева (index 0),
 * далее видимые папки в том же порядке, что иконки (custom → Архив).
 */
export function chatListFolderPageIds(
  visibleFolders: readonly ChatListFolderDef[],
): ChatListFolderId[] {
  return ["all", ...visibleFolders.map((f) => f.id)];
}

export function chatListFolderPageIndex(
  pages: readonly ChatListFolderId[],
  folder: ChatListFolderId,
): number {
  const index = pages.indexOf(folder);
  return index < 0 ? 0 : index;
}

/** Если активная папка исчезла — вернуться к «всем». */
export function normalizeChatListFolder(
  folder: ChatListFolderId,
  archivedCount: number,
  knownCustomIds?: ReadonlySet<string>,
): ChatListFolderId {
  if (folder === "archived" && archivedCount <= 0) return "all";
  if (
    folder !== "all" &&
    folder !== "archived" &&
    knownCustomIds &&
    !knownCustomIds.has(folder)
  ) {
    return "all";
  }
  return folder;
}

export function isPeerArchived(
  peerUuid: string,
  archivedByPeer: Readonly<Record<string, true>>,
): boolean {
  return peerUuid in archivedByPeer;
}

export function filterConversationsByFolder<T extends { otherUserUuid: string }>(
  items: readonly T[],
  folder: ChatListFolderId,
  archivedByPeer: Readonly<Record<string, true>>,
  membershipByFolderId: Readonly<Record<string, readonly string[]>> = {},
): T[] {
  if (folder === "archived") {
    return items.filter((item) => isPeerArchived(item.otherUserUuid, archivedByPeer));
  }

  if (folder === "all") {
    return items.filter((item) => !isPeerArchived(item.otherUserUuid, archivedByPeer));
  }

  const members = membershipByFolderId[folder];
  if (!members) return [];
  const memberSet = new Set(members);
  return items.filter(
    (item) =>
      memberSet.has(item.otherUserUuid) && !isPeerArchived(item.otherUserUuid, archivedByPeer),
  );
}

/** Убрать из карты архива пиров, которых больше нет в списке (удалённый чат). */
export function pruneArchivedPeers(
  archivedByPeer: Readonly<Record<string, true>>,
  knownPeerUuids: ReadonlySet<string>,
): Record<string, true> {
  let changed = false;
  const next: Record<string, true> = {};
  for (const uuid of Object.keys(archivedByPeer)) {
    if (knownPeerUuids.has(uuid)) {
      next[uuid] = true;
    } else {
      changed = true;
    }
  }
  return changed ? next : (archivedByPeer as Record<string, true>);
}

export function setPeerArchivedFlag(
  archivedByPeer: Readonly<Record<string, true>>,
  peerUuid: string,
  archived: boolean,
): Record<string, true> {
  if (archived) {
    if (peerUuid in archivedByPeer) return archivedByPeer as Record<string, true>;
    return { ...archivedByPeer, [peerUuid]: true };
  }
  if (!(peerUuid in archivedByPeer)) return archivedByPeer as Record<string, true>;
  const next = { ...archivedByPeer };
  delete next[peerUuid];
  return next;
}

export function setPeerMutedFlag(
  mutedByPeer: Readonly<Record<string, true>>,
  peerUuid: string,
  muted: boolean,
): Record<string, true> {
  return setPeerArchivedFlag(mutedByPeer, peerUuid, muted);
}

export function parseChatListOverlayState(raw: unknown): ChatListOverlayState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (!Array.isArray(o.entities)) return null;
  const entities: ChatListCustomEntity[] = [];
  for (const item of o.entities) {
    const parsed = parseCustomEntity(item);
    if (parsed) entities.push(parsed);
  }
  return {
    v: 1,
    entities,
    archivedByPeer: parsePeerFlagMap(o.archivedByPeer),
    mutedByPeer: parsePeerFlagMap(o.mutedByPeer),
  };
}

/** Ответ `GET /api/messaging/chat-list-overlay` → локальный state. */
export function chatListOverlayFromApi(raw: unknown): ChatListOverlayState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.entities)) return null;
  const entities: ChatListCustomEntity[] = [];
  for (const item of o.entities) {
    const parsed = parseApiEntity(item);
    if (parsed) entities.push(parsed);
  }
  return {
    v: 1,
    entities,
    archivedByPeer: peerUuidsToFlagMap(o.archivedPeerUuids ?? o.archived_peer_uuids),
    mutedByPeer: peerUuidsToFlagMap(o.mutedPeerUuids ?? o.muted_peer_uuids),
  };
}

export function chatListEntityFromApi(raw: unknown): ChatListCustomEntity | null {
  return parseApiEntity(raw);
}

function parseCustomEntity(raw: unknown): ChatListCustomEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (o.kind !== "folder" && o.kind !== "group") return null;
  if (typeof o.label !== "string" || !o.label.trim()) return null;
  if (!Array.isArray(o.memberPeerUuids)) return null;
  const members = uniquePeerUuids(
    o.memberPeerUuids.filter((x): x is string => typeof x === "string"),
  );
  const createdAtMs = typeof o.createdAtMs === "number" && Number.isFinite(o.createdAtMs)
    ? o.createdAtMs
    : Date.now();
  return {
    id: o.id,
    kind: o.kind,
    label: o.label.trim().slice(0, 80),
    icon: typeof o.icon === "string" ? o.icon : undefined,
    avatarUri: typeof o.avatarUri === "string" ? o.avatarUri : o.avatarUri === null ? null : undefined,
    memberPeerUuids: members,
    createdAtMs,
  };
}

function parseApiEntity(raw: unknown): ChatListCustomEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  if (!id) return null;
  const kindRaw = o.kind;
  const kind =
    kindRaw === "folder" || kindRaw === "group"
      ? kindRaw
      : kindRaw === "Folder"
        ? "folder"
        : kindRaw === "Group"
          ? "group"
          : null;
  if (!kind) return null;
  if (typeof o.label !== "string" || !o.label.trim()) return null;
  const membersRaw = o.memberPeerUuids ?? o.member_peer_uuids;
  if (!Array.isArray(membersRaw)) return null;
  const members = uniquePeerUuids(
    membersRaw.filter((x): x is string => typeof x === "string"),
  );
  const createdAt =
    typeof o.createdAt === "string"
      ? o.createdAt
      : typeof o.created_at === "string"
        ? o.created_at
        : "";
  const createdAtMs = createdAt ? Date.parse(createdAt) : NaN;
  return {
    id,
    kind,
    label: o.label.trim().slice(0, 80),
    icon: typeof o.icon === "string" ? o.icon : undefined,
    avatarUri:
      typeof o.avatarUri === "string"
        ? o.avatarUri
        : typeof o.avatar_uri === "string"
          ? o.avatar_uri
          : o.avatarUri === null || o.avatar_uri === null
            ? null
            : undefined,
    memberPeerUuids: members,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
  };
}

function peerUuidsToFlagMap(raw: unknown): Record<string, true> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, true> = {};
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) out[item.trim()] = true;
  }
  return out;
}

function parsePeerFlagMap(raw: unknown): Record<string, true> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, true> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === true && k.trim()) out[k] = true;
  }
  return out;
}

function uniquePeerUuids(peers: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of peers) {
    const id = p.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
