import { fromBase64Url } from "@/lib/fscp/base64url";
import { resolveVoicePlaybackMime } from "@/lib/voicePlaybackMime";

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function encryptVoiceBlob(blob: Blob): Promise<{
  encryptedBlob: Blob;
  keyBase64Url: string;
  nonceBase64Url: string;
}> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["encrypt"]);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, await blob.arrayBuffer());
  return {
    encryptedBlob: new Blob([cipher], { type: "application/octet-stream" }),
    keyBase64Url: toBase64Url(keyBytes),
    nonceBase64Url: toBase64Url(nonce),
  };
}

export async function decryptVoiceBlob(params: {
  encryptedBlob: Blob;
  keyBase64Url: string;
  nonceBase64Url: string;
  contentType: string;
}): Promise<Blob> {
  const keyBytes = fromBase64Url(params.keyBase64Url);
  const nonce = fromBase64Url(params.nonceBase64Url);
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    key,
    await params.encryptedBlob.arrayBuffer()
  );
  const bytes = new Uint8Array(plain);
  const mime = resolveVoicePlaybackMime(bytes, params.contentType);
  return new Blob([bytes], { type: mime });
}
