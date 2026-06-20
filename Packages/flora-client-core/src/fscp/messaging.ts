import { authGetJson, authPostJson } from "../api/client.js";
import { getApiClientConfig } from "../api/client.js";
import { isApiRequestError } from "../api/errors.js";
import { asRecord, readStr } from "../contracts/parse.js";
import type { MsgSentMessageDto } from "../contracts/messaging.js";
import {
  buildFscpWireEnvelope,
  decryptFscpWireEnvelope,
  isFscpWirePayload,
  type FscpMessageBlock,
  type FscpMessagePlaintext,
} from "./envelope.js";
import { loadOrCreateFscpLocalMaterial, type FscpLocalMaterial } from "./keys.js";
import type { FscpKeyStorageAdapter } from "./keyStorage.js";
import { fromBase64Url } from "./base64url.js";
import { messagePlaintextFromBlocks, messagePlaintextFromText, plaintextToPreview } from "./preview.js";

export type UserE2eKeyBundle = {
  publicKeyBase64: string;
  deviceUuid: string | null;
};

export async function apiGetUserE2ePublicKey(userUuid: string): Promise<UserE2eKeyBundle> {
  const raw = await authGetJson(`/api/auth/users/${encodeURIComponent(userUuid)}/e2e-public-key`);
  const o = asRecord(raw) ?? {};
  const du = readStr(o, ["deviceUuid", "DeviceUuid"]);
  return {
    publicKeyBase64: readStr(o, ["publicKeyBase64", "PublicKeyBase64"]),
    deviceUuid: du.length > 0 ? du : null,
  };
}

export async function apiTryGetUserE2ePublicKey(userUuid: string): Promise<UserE2eKeyBundle | null> {
  try {
    return await apiGetUserE2ePublicKey(userUuid);
  } catch (e) {
    if (isApiRequestError(e) && e.status === 404) return null;
    throw e;
  }
}

export async function apiPutMyE2ePublicKey(
  publicKeyBase64: string,
  deviceUuid?: string | null,
): Promise<{ deviceUuid: string }> {
  const body: Record<string, unknown> = { publicKeyBase64 };
  if (deviceUuid && deviceUuid.length > 0) body.deviceUuid = deviceUuid;
  const raw = await authPostJson("/api/auth/me/e2e-public-key", body);
  const o = asRecord(raw) ?? {};
  return { deviceUuid: readStr(o, ["deviceUuid", "DeviceUuid"]) };
}

export async function bootstrapFscpMaterial(
  storage: FscpKeyStorageAdapter,
  ownerUserUuid: string,
): Promise<FscpLocalMaterial> {
  return loadOrCreateFscpLocalMaterial(
    storage,
    async (publicKeyBase64Url, deviceUuid) => {
      const up = await apiPutMyE2ePublicKey(publicKeyBase64Url, deviceUuid);
      return { deviceUuid: up.deviceUuid };
    },
    ownerUserUuid,
  );
}

export async function buildTextMessageWire(params: {
  senderUserUuid: string;
  receiverUserUuid: string;
  material: FscpLocalMaterial;
  receiverAgreementPublicKeyBase64: string;
  text: string;
  replyTo?: FscpMessagePlaintext["replyTo"];
}): Promise<string> {
  return buildBlocksMessageWire({
    senderUserUuid: params.senderUserUuid,
    receiverUserUuid: params.receiverUserUuid,
    material: params.material,
    receiverAgreementPublicKeyBase64: params.receiverAgreementPublicKeyBase64,
    blocks: [{ kind: "text", body: params.text }],
    replyTo: params.replyTo,
  });
}

export async function buildBlocksMessageWire(params: {
  senderUserUuid: string;
  receiverUserUuid: string;
  material: FscpLocalMaterial;
  receiverAgreementPublicKeyBase64: string;
  blocks: FscpMessageBlock[];
  replyTo?: FscpMessagePlaintext["replyTo"];
}): Promise<string> {
  const receiverAgreementPublicKey = fromBase64Url(params.receiverAgreementPublicKeyBase64);
  const payload = messagePlaintextFromBlocks(params.blocks);
  if (params.replyTo) payload.replyTo = params.replyTo;
  return buildFscpWireEnvelope({
    senderUserUuid: params.senderUserUuid,
    receiverUserUuid: params.receiverUserUuid,
    senderAgreementPrivateKey: params.material.agreementPrivateKey,
    senderSigningPrivateKey: params.material.signingPrivateKey,
    receiverAgreementPublicKey,
    messagePayload: payload,
  });
}

export async function decryptMessageWire(params: {
  wire: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
}): Promise<FscpMessagePlaintext> {
  return decryptFscpWireEnvelope(params);
}

export async function decryptMessagePreview(params: {
  encryptedPayload: string | null | undefined;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
}): Promise<string | null> {
  const enc = params.encryptedPayload?.trim();
  if (!enc) return null;
  if (!isFscpWirePayload(enc)) return null;
  try {
    const plain = await decryptFscpWireEnvelope({
      wire: enc,
      viewerUserUuid: params.viewerUserUuid,
      agreementPrivateKey: params.agreementPrivateKey,
    });
    return plaintextToPreview(plain);
  } catch {
    return "🔒";
  }
}

export type MessageSendAttachments = {
  voiceAssetUuids?: string[];
  imageAssetUuids?: string[];
  videoAssetUuids?: string[];
};

export async function sendTextMessage(params: {
  conversationUuid: string;
  wire: string;
  attachments?: MessageSendAttachments;
  pushPreview?: string;
  previewBlocks?: FscpMessageBlock[];
}): Promise<MsgSentMessageDto> {
  const voiceAssetUuids = params.attachments?.voiceAssetUuids ?? [];
  const imageAssetUuids = params.attachments?.imageAssetUuids ?? [];
  const videoAssetUuids = params.attachments?.videoAssetUuids ?? [];
  const pushPreview =
    params.pushPreview?.trim() ||
    (params.previewBlocks?.length
      ? plaintextToPreview(messagePlaintextFromBlocks(params.previewBlocks))
      : undefined);
  const body: Record<string, unknown> = {
    encryptedForReceiver: params.wire,
    encryptedForSender: params.wire,
    voiceAssetUuids,
    imageAssetUuids,
    videoAssetUuids,
  };
  if (pushPreview) body.pushPreview = pushPreview;
  const raw = await authPostJson(`/api/messaging/conversations/${params.conversationUuid}/messages`, body);
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const messageUuid = readStr(o, ["messageUuid", "MessageUuid"], fb);
  if (!messageUuid) throw new Error("Некорректный ответ сервера при отправке сообщения.");
  return {
    messageUuid,
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb) || new Date().toISOString(),
    encryptedForMe: readStr(o, ["encryptedForMe", "EncryptedForMe"], fb),
  } satisfies MsgSentMessageDto;
}
