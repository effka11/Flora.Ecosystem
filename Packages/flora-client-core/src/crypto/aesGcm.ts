import { fromBase64Url } from "../fscp/base64url.js";
import { toBase64Url } from "../fscp/unlockFlow.js";

export type AesGcmSubtle = Pick<
  SubtleCrypto,
  "importKey" | "encrypt" | "decrypt"
>;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export async function encryptAesGcmBlob(
  subtle: AesGcmSubtle,
  blob: Blob,
  contentType = "application/octet-stream",
): Promise<{ encryptedBlob: Blob; keyBase64Url: string; nonceBase64Url: string; contentType: string }> {
  const keyBytes = randomBytes(32);
  const nonce = randomBytes(12);
  const key = await subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["encrypt"]);
  const cipher = await subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(nonce) }, key, await blob.arrayBuffer());
  return {
    encryptedBlob: new Blob([cipher], { type: "application/octet-stream" }),
    keyBase64Url: toBase64Url(keyBytes),
    nonceBase64Url: toBase64Url(nonce),
    contentType,
  };
}

export async function decryptAesGcmBlob(
  subtle: AesGcmSubtle,
  params: {
    encryptedBlob: Blob;
    keyBase64Url: string;
    nonceBase64Url: string;
    contentType: string;
  },
): Promise<Blob> {
  const keyBytes = fromBase64Url(params.keyBase64Url);
  const nonce = fromBase64Url(params.nonceBase64Url);
  const key = await subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["decrypt"]);
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    key,
    await params.encryptedBlob.arrayBuffer(),
  );
  return new Blob([plain], { type: params.contentType || "application/octet-stream" });
}
