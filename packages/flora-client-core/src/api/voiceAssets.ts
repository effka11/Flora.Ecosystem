import { asRecord, readNum, readStr } from "../contracts/parse.js";
import { authGetArrayBuffer, authPostForm, getApiClientConfig } from "./client.js";

export type UploadedMessageVoiceAsset = {
  voiceAssetUuid: string;
  contentType: string;
  durationMs: number;
};

export async function apiUploadMessageVoiceAsset(params: {
  toUserUuid: string;
  encryptedBlob: Blob;
  durationMs: number;
}): Promise<UploadedMessageVoiceAsset> {
  const body = new FormData();
  body.set("toUserUuid", params.toUserUuid);
  body.set("durationMs", String(Math.max(1, Math.round(params.durationMs))));
  body.set("file", params.encryptedBlob, "voice-message.bin");
  const raw = await authPostForm("/api/messaging/voice-assets", body);
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const voiceAssetUuid = readStr(o, ["voiceAssetUuid", "VoiceAssetUuid"], fb);
  if (!voiceAssetUuid) throw new Error("Некорректный ответ сервера при загрузке голосового.");
  return {
    voiceAssetUuid,
    contentType: readStr(o, ["contentType", "ContentType"], fb) || "application/octet-stream",
    durationMs: readNum(o, ["durationMs", "DurationMs"], fb) || params.durationMs,
  };
}

export async function apiDownloadMessageVoiceAsset(voiceAssetUuid: string): Promise<ArrayBuffer> {
  const id = encodeURIComponent(voiceAssetUuid.trim());
  return authGetArrayBuffer(`/api/messaging/voice-assets/${id}`);
}
