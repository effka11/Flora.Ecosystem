import { authDelete, authGetArrayBuffer, authGetJson, authPostForm, authPostJson } from "./client.js";
import { getApiClientConfig } from "./client.js";
import { ApiRequestError } from "./errors.js";
import { asRecord, readBool, readStr } from "../contracts/parse.js";
import {
  parseConversationsPage,
  parseMessagesPage,
  type MsgConversationsPage,
  type MsgMessagesPage,
} from "../contracts/messaging.js";
export type MsgE2EState = {
  state:
    | "not_initialized"
    | "active"
    | "locked"
    | "active_new_epoch"
    | "recovering"
    | "rotating"
    | "frozen";
  freeze: boolean;
  updatedAt: string;
};

function ctx() {
  return { onPascalFallback: getApiClientConfig().onPascalFallback };
}

export async function apiGetConversations(cursor?: string): Promise<MsgConversationsPage> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const raw = await authGetJson(`/api/messaging/conversations${q}`);
  return parseConversationsPage(raw, ctx());
}

/** Сервер отдаёт newest-first; UI чата ожидает oldest-first. */
export async function apiGetMessages(
  conversationUuid: string,
  cursor?: string,
  otherUserUuid?: string,
): Promise<MsgMessagesPage> {
  const q = new URLSearchParams();
  if (cursor) q.set("cursor", cursor);
  if (otherUserUuid?.trim()) q.set("otherUserUuid", otherUserUuid.trim());
  const qs = q.toString();
  const raw = await authGetJson(
    `/api/messaging/conversations/${conversationUuid}/messages${qs ? `?${qs}` : ""}`,
  );
  const page = parseMessagesPage(raw, ctx());
  return { ...page, items: [...page.items].reverse() };
}

export async function apiSendMessage(
  conversationUuid: string,
  encryptedForReceiver: string,
  encryptedForSender?: string,
  encryptedPushPreviews?: EncryptedPushPreviewInput[],
): Promise<unknown> {
  const wire = encryptedForSender ?? encryptedForReceiver;
  return authPostJson(`/api/messaging/conversations/${conversationUuid}/messages`, {
    encryptedForReceiver,
    encryptedForSender: wire,
    encryptedPushPreviews: encryptedPushPreviews ?? [],
  });
}

export type PushPreviewTarget = {
  installationUuid: string;
  previewKeyId: string;
  publicKeyBase64Url: string;
  protocolVersion: number;
};

export type EncryptedPushPreviewInput = {
  installationUuid: string;
  previewKeyId: string;
  envelope: string;
};

export async function apiGetPushPreviewTargets(
  recipientUserUuid: string,
): Promise<PushPreviewTarget[]> {
  const raw = await authGetJson(
    `/api/messaging/push-preview-targets/${encodeURIComponent(recipientUserUuid.trim())}`,
  );
  if (!Array.isArray(raw)) return [];
  const fb = getApiClientConfig().onPascalFallback;
  return raw.flatMap((item) => {
    const value = asRecord(item);
    if (!value) return [];
    const installationUuid = readStr(value, ["installationUuid", "InstallationUuid"], fb);
    const previewKeyId = readStr(value, ["previewKeyId", "PreviewKeyId"], fb);
    const publicKeyBase64Url = readStr(
      value,
      ["publicKeyBase64Url", "PublicKeyBase64Url"],
      fb,
    );
    const protocolRaw = value.protocolVersion ?? value.ProtocolVersion;
    const protocolVersion =
      typeof protocolRaw === "number" && Number.isInteger(protocolRaw) ? protocolRaw : 0;
    return installationUuid && previewKeyId && publicKeyBase64Url && protocolVersion === 1
      ? [{ installationUuid, previewKeyId, publicKeyBase64Url, protocolVersion }]
      : [];
  });
}

export async function apiMarkConversationRead(conversationUuid: string): Promise<void> {
  await authPostJson(`/api/messaging/conversations/${conversationUuid}/read`, {});
}

export async function apiDeleteMessage(conversationUuid: string, messageUuid: string): Promise<void> {
  const conv = encodeURIComponent(conversationUuid.trim());
  const msg = encodeURIComponent(messageUuid.trim());
  await authDelete(`/api/messaging/conversations/${conv}/messages/${msg}`);
}

export async function apiDeleteConversation(
  conversationUuid: string,
  otherUserUuid?: string,
): Promise<void> {
  const q = new URLSearchParams();
  if (otherUserUuid?.trim()) q.set("otherUserUuid", otherUserUuid.trim());
  const qs = q.toString();
  await authDelete(
    `/api/messaging/conversations/${encodeURIComponent(conversationUuid.trim())}${qs ? `?${qs}` : ""}`,
  );
}

export async function apiGetE2EState(): Promise<MsgE2EState> {
  const raw = await authGetJson("/api/messaging/e2e/state");
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  return {
    state: (readStr(o, ["state", "State"], fb) || "not_initialized") as MsgE2EState["state"],
    freeze: readBool(o, ["freeze", "Freeze"], fb),
    updatedAt: readStr(o, ["updatedAt", "UpdatedAt"], fb),
  };
}

export type EpochIdentityPublicKeyEntry = {
  keyEpochId: string;
  epochAccountIdentityPublicKeyBase64Url: string;
};

export type PutKeyBackupRequest = {
  keyBackup: Record<string, unknown>;
  epochIdentityPublicKeys: EpochIdentityPublicKeyEntry[];
};

export async function apiPutKeyBackup(body: PutKeyBackupRequest): Promise<void> {
  // POST (not PUT): production CDN on social.* returns 405 for PUT on API routes.
  await authPostJson("/api/messaging/e2e/key-backup", body as unknown as Record<string, unknown>);
}

export async function apiGetKeyBackup(): Promise<unknown> {
  return authGetJson("/api/messaging/e2e/key-backup");
}

export async function apiPutRecoveryBackup(body: Record<string, unknown>): Promise<unknown> {
  return authPostJson("/api/messaging/e2e/recovery-backup", body);
}

export async function apiGetRecoveryBackup(): Promise<unknown> {
  return authGetJson("/api/messaging/e2e/recovery-backup");
}

// ── E2E recovery / unlock / devices (e2e-security.md §API, errata-5) ─────────

/** GET recovery-backups — метаданные всех recovery-записей (без ciphertext). */
export async function apiGetRecoveryBackups(): Promise<unknown> {
  return authGetJson("/api/messaging/e2e/recovery-backups");
}

export type MsgRecoveryBackupWithToken = {
  /** Полный payload recovery backup (ciphertext + KDF/AEAD параметры). */
  raw: Record<string, unknown>;
  /**
   * Короткоживущий proof-токен для unlock-complete; сервер выдаёт его только
   * в FSM `recovering` (errata-5). null — вне recovery-flow.
   */
  recoveryUnlockToken: string | null;
  recoveryUnlockTokenExpiresAt: string | null;
};

/** GET recovery-backup/{recoveryKeyId} — ciphertext + recoveryUnlockToken в recovering. */
export async function apiGetRecoveryBackupById(
  recoveryKeyId: string,
): Promise<MsgRecoveryBackupWithToken> {
  const raw = await authGetJson(
    `/api/messaging/e2e/recovery-backup/${encodeURIComponent(recoveryKeyId.trim())}`,
  );
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const token = readStr(o, ["recoveryUnlockToken", "RecoveryUnlockToken"], fb);
  const expires = readStr(
    o,
    ["recoveryUnlockTokenExpiresAt", "RecoveryUnlockTokenExpiresAt"],
    fb,
  );
  return {
    raw: o,
    recoveryUnlockToken: token.length > 0 ? token : null,
    recoveryUnlockTokenExpiresAt: expires.length > 0 ? expires : null,
  };
}

export type MsgUnlockChallenge = {
  challengeId: string;
  resetRequestId: string;
  expiresAt: string;
  canonicalPayloadPreview: string;
};

/** POST unlock-complete/challenge — выдаёт challengeId/resetRequestId (FSM recovering). */
export async function apiRequestUnlockChallenge(): Promise<MsgUnlockChallenge> {
  const raw = await authPostJson("/api/messaging/e2e/unlock-complete/challenge", {});
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  return {
    challengeId: readStr(o, ["challengeId", "ChallengeId"], fb),
    resetRequestId: readStr(o, ["resetRequestId", "ResetRequestId"], fb),
    expiresAt: readStr(o, ["expiresAt", "ExpiresAt"], fb),
    canonicalPayloadPreview: readStr(o, ["canonicalPayloadPreview", "CanonicalPayloadPreview"], fb),
  };
}

export type MsgUnlockCompleteRequest = {
  resetRequestId: string;
  idempotencyKey: string;
  challengeId: string;
  recoveredKeyEpochIds: string[];
  epochIdentityPublicKeys: { keyEpochId: string; valueBase64Url: string }[];
  epochUnlockSignatures: { keyEpochId: string; valueBase64Url: string }[];
  keyBackup: Record<string, unknown>;
  newDeviceSigningPublicKeyBase64Url: string;
  newDeviceAgreementPublicKeyBase64Url: string;
  recoveryUnlockToken?: string;
  trustedDeviceApprovalToken?: string;
};

/** POST unlock-complete — восстановление доступа (нужен один валидный proof-токен). */
export async function apiUnlockComplete(body: MsgUnlockCompleteRequest): Promise<void> {
  await authPostJson(
    "/api/messaging/e2e/unlock-complete",
    body as unknown as Record<string, unknown>,
  );
}

export type MsgDeviceKeyEntry = {
  deviceUuid: string;
  keyEpochId: string;
  displayName: string;
  signingPublicKeyBase64Url: string;
  agreementPublicKeyBase64Url: string;
  status: string;
  createdAt: string;
};

/** GET epochs/{keyEpochId}/devices — server-attested список устройств epoch. */
export async function apiGetEpochDevices(keyEpochId: string): Promise<MsgDeviceKeyEntry[]> {
  const raw = await authGetJson(
    `/api/messaging/e2e/epochs/${encodeURIComponent(keyEpochId.trim())}/devices`,
  );
  if (!Array.isArray(raw)) return [];
  const fb = getApiClientConfig().onPascalFallback;
  return raw.map((item) => {
    const o = asRecord(item) ?? {};
    return {
      deviceUuid: readStr(o, ["deviceUuid", "DeviceUuid"], fb),
      keyEpochId: readStr(o, ["keyEpochId", "KeyEpochId"], fb),
      displayName: readStr(o, ["displayName", "DisplayName"], fb),
      signingPublicKeyBase64Url: readStr(o, ["signingPublicKeyBase64Url", "SigningPublicKeyBase64Url"], fb),
      agreementPublicKeyBase64Url: readStr(o, ["agreementPublicKeyBase64Url", "AgreementPublicKeyBase64Url"], fb),
      status: readStr(o, ["status", "Status"], fb),
      createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    };
  });
}

/** POST epochs/{keyEpochId}/devices/pending — регистрация ключей нового устройства. */
export async function apiAddPendingDevice(
  keyEpochId: string,
  body: {
    signingPublicKeyBase64Url: string;
    agreementPublicKeyBase64Url: string;
    displayName?: string;
  },
): Promise<{ deviceUuid: string }> {
  const raw = await authPostJson(
    `/api/messaging/e2e/epochs/${encodeURIComponent(keyEpochId.trim())}/devices/pending`,
    body as unknown as Record<string, unknown>,
  );
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const deviceUuid = readStr(o, ["deviceUuid", "DeviceUuid"], fb);
  if (!deviceUuid) throw new Error("Некорректный ответ сервера при регистрации устройства.");
  return { deviceUuid };
}

export type MsgApproveDeviceResult = {
  deviceUuid: string;
  /** Proof-токен для unlock-complete в trusted-device flow (errata-5). */
  trustedDeviceApprovalToken: string | null;
  trustedDeviceApprovalTokenExpiresAt: string | null;
};

/**
 * POST epochs/{keyEpochId}/devices/{deviceUuid}/approve — старое active-устройство
 * подтверждает pending-устройство подписью Ed25519 над canonical payload
 * `flora.messaging.device-approve.v1 | userUuid | keyEpochId | newDeviceUuid | approvingDeviceUuid`.
 */
export async function apiApproveDevice(
  keyEpochId: string,
  deviceUuid: string,
  body: { approvingDeviceUuid: string; approvalSignatureBase64Url: string },
): Promise<MsgApproveDeviceResult> {
  const raw = await authPostJson(
    `/api/messaging/e2e/epochs/${encodeURIComponent(keyEpochId.trim())}/devices/${encodeURIComponent(deviceUuid.trim())}/approve`,
    body as unknown as Record<string, unknown>,
  );
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const token = readStr(o, ["trustedDeviceApprovalToken", "TrustedDeviceApprovalToken"], fb);
  const expires = readStr(
    o,
    ["trustedDeviceApprovalTokenExpiresAt", "TrustedDeviceApprovalTokenExpiresAt"],
    fb,
  );
  return {
    deviceUuid: readStr(o, ["deviceUuid", "DeviceUuid"], fb) || deviceUuid,
    trustedDeviceApprovalToken: token.length > 0 ? token : null,
    trustedDeviceApprovalTokenExpiresAt: expires.length > 0 ? expires : null,
  };
}

/** POST epochs/{keyEpochId}/devices/{deviceUuid}/revoke (POST-алиас — CDN-safe). */
export async function apiRevokeDevice(keyEpochId: string, deviceUuid: string): Promise<void> {
  await authPostJson(
    `/api/messaging/e2e/epochs/${encodeURIComponent(keyEpochId.trim())}/devices/${encodeURIComponent(deviceUuid.trim())}/revoke`,
    {},
  );
}

export type MsgDeviceRecoveryEnvelopeReceipt = {
  recoveryRequestId: string;
  expiresAt: string;
};

export type MsgDeviceRecoveryEnvelopeStored = {
  /** Opaque DeviceToDeviceRecoveryEnvelope — открывать через @flora/fscp openDeviceRecoveryEnvelope. */
  envelope: unknown;
  sourceDeviceUuid: string;
  recoveryRequestId: string;
  createdAt: string;
  expiresAt: string;
};

/**
 * POST epochs/{keyEpochId}/devices/{deviceUuid}/recover-key — source-устройство кладёт
 * DeviceToDeviceRecoveryEnvelope (собранный buildDeviceRecoveryEnvelope из @flora/fscp)
 * для target-устройства {deviceUuid}. Сервер проверяет форму/binding/подпись,
 * не расшифровывает; конверт живёт до expiresAt (e2e-security.md §Devices).
 */
export async function apiPostDeviceRecoveryEnvelope(
  keyEpochId: string,
  targetDeviceUuid: string,
  envelope: unknown,
): Promise<MsgDeviceRecoveryEnvelopeReceipt> {
  const raw = await authPostJson(
    `/api/messaging/e2e/epochs/${encodeURIComponent(keyEpochId.trim())}/devices/${encodeURIComponent(targetDeviceUuid.trim())}/recover-key`,
    { envelope } as unknown as Record<string, unknown>,
  );
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  return {
    recoveryRequestId: readStr(o, ["recoveryRequestId", "RecoveryRequestId"], fb),
    expiresAt: readStr(o, ["expiresAt", "ExpiresAt"], fb),
  };
}

/**
 * GET epochs/{keyEpochId}/devices/{deviceUuid}/recover-key — target-устройство забирает
 * сохранённый конверт; `null`, если конверта нет или истёк TTL (404).
 */
export async function apiGetDeviceRecoveryEnvelope(
  keyEpochId: string,
  targetDeviceUuid: string,
): Promise<MsgDeviceRecoveryEnvelopeStored | null> {
  let raw: unknown;
  try {
    raw = await authGetJson(
      `/api/messaging/e2e/epochs/${encodeURIComponent(keyEpochId.trim())}/devices/${encodeURIComponent(targetDeviceUuid.trim())}/recover-key`,
    );
  } catch (e: unknown) {
    if (e instanceof ApiRequestError && e.status === 404) return null;
    throw e;
  }
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const envelope = o["envelope"] ?? o["Envelope"];
  if (envelope === undefined || envelope === null) return null;
  return {
    envelope,
    sourceDeviceUuid: readStr(o, ["sourceDeviceUuid", "SourceDeviceUuid"], fb),
    recoveryRequestId: readStr(o, ["recoveryRequestId", "RecoveryRequestId"], fb),
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    expiresAt: readStr(o, ["expiresAt", "ExpiresAt"], fb),
  };
}

function conversationPeerQs(otherUserUuid: string): string {
  return `?otherUserUuid=${encodeURIComponent(otherUserUuid.trim())}`;
}

/** GET /api/messaging/chat-list-overlay — папки + archive/mute (без FSCP). */
export async function apiGetChatListOverlay(): Promise<unknown> {
  return authGetJson("/api/messaging/chat-list-overlay");
}

export async function apiCreateChatFolder(body: {
  kind: "folder" | "group";
  label: string;
  icon?: string;
  avatarUri?: string | null;
  memberPeerUuids?: readonly string[];
}): Promise<unknown> {
  return authPostJson("/api/messaging/chat-folders", {
    kind: body.kind,
    label: body.label,
    icon: body.icon,
    avatarUri: body.avatarUri ?? undefined,
    memberPeerUuids: [...(body.memberPeerUuids ?? [])],
  });
}

export async function apiDeleteChatFolder(folderId: string): Promise<void> {
  await authDelete(`/api/messaging/chat-folders/${encodeURIComponent(folderId.trim())}`);
}

export async function apiAddChatFolderMember(
  folderId: string,
  otherUserUuid: string,
): Promise<void> {
  await authPostJson(
    `/api/messaging/chat-folders/${encodeURIComponent(folderId.trim())}/members`,
    { otherUserUuid: otherUserUuid.trim() },
  );
}

/**
 * Archive/mute — overlay flags keyed by peer.
 * На main серверных route не было (только клиентские stubs без query);
 * `otherUserUuid` обязателен для записи `user_conversation_flags`.
 */
export async function apiArchiveConversation(
  conversationUuid: string,
  otherUserUuid: string,
): Promise<void> {
  await authPostJson(
    `/api/messaging/conversations/${encodeURIComponent(conversationUuid.trim())}/archive${conversationPeerQs(otherUserUuid)}`,
    {},
  );
}

export async function apiUnarchiveConversation(
  conversationUuid: string,
  otherUserUuid: string,
): Promise<void> {
  await authPostJson(
    `/api/messaging/conversations/${encodeURIComponent(conversationUuid.trim())}/unarchive${conversationPeerQs(otherUserUuid)}`,
    {},
  );
}

/** Mirror ORG group archive into `user_group_conversation_flags` (badge / LIMIT). */
export async function apiArchiveGroupConversation(conversationUuid: string): Promise<void> {
  await authPostJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}/archive`,
    {},
  );
}

export async function apiUnarchiveGroupConversation(conversationUuid: string): Promise<void> {
  await authPostJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}/unarchive`,
    {},
  );
}

/** Server projection of archived FSCP-G groups (for ORG reconcile). */
export async function apiListArchivedGroupConversationUuids(): Promise<string[]> {
  const raw = await authGetJson("/api/messaging/group-archive-flags");
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const list = o.archivedConversationUuids ?? o.ArchivedConversationUuids;
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

export async function apiMuteConversation(
  conversationUuid: string,
  otherUserUuid: string,
): Promise<void> {
  await authPostJson(
    `/api/messaging/conversations/${encodeURIComponent(conversationUuid.trim())}/mute${conversationPeerQs(otherUserUuid)}`,
    {},
  );
}

export async function apiUnmuteConversation(
  conversationUuid: string,
  otherUserUuid: string,
): Promise<void> {
  await authPostJson(
    `/api/messaging/conversations/${encodeURIComponent(conversationUuid.trim())}/unmute${conversationPeerQs(otherUserUuid)}`,
    {},
  );
}

export type UploadedMessageImageAsset = {
  imageAssetUuid: string;
  contentType: string;
};

export async function apiUploadMessageImageAsset(params: {
  toUserUuid: string;
  encryptedBlob: Blob;
  contentType: string;
}): Promise<UploadedMessageImageAsset> {
  const body = new FormData();
  body.set("toUserUuid", params.toUserUuid);
  body.set("contentType", params.contentType);
  body.set("file", params.encryptedBlob, "message-image.bin");
  const raw = await authPostForm("/api/messaging/image-assets", body);
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const imageAssetUuid = readStr(o, ["imageAssetUuid", "ImageAssetUuid"], fb);
  if (!imageAssetUuid) throw new Error("Некорректный ответ сервера при загрузке фото.");
  return {
    imageAssetUuid,
    contentType: readStr(o, ["contentType", "ContentType"], fb) || params.contentType,
  };
}

export async function apiDownloadMessageImageAsset(imageAssetUuid: string): Promise<ArrayBuffer> {
  const id = encodeURIComponent(imageAssetUuid.trim());
  return authGetArrayBuffer(`/api/messaging/image-assets/${id}`);
}

/** GET /api/messaging/unread-count — число чатов с непрочитанным (не сообщений). */
export async function apiMessagingUnreadCount(): Promise<number> {
  const raw = await authGetJson("/api/messaging/unread-count");
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const count = o.unreadCount ?? o.UnreadCount ?? o.count ?? o.Count;
  return typeof count === "number" ? count : Number(count) || 0;
}
