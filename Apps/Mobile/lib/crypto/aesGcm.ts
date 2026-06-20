import QuickCryptoModule from "react-native-quick-crypto";

const QuickCrypto =
  (QuickCryptoModule as { default?: typeof QuickCryptoModule }).default ?? QuickCryptoModule;

function getSubtle() {
  const subtle = globalThis.crypto?.subtle ?? QuickCrypto.webcrypto?.subtle;
  if (!subtle) throw new Error("Web Crypto недоступен в этой сборке.");
  return subtle;
}

function randomBytes(length: number): Uint8Array {
  if (typeof QuickCrypto.randomBytes === "function") {
    return new Uint8Array(QuickCrypto.randomBytes(length));
  }
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const t = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 === 0 ? "" : "=".repeat(4 - (t.length % 4));
  const bin = atob(t + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const subtle = getSubtle();

/** Шифрование медиа без Blob (Hermes/RN не поддерживает Blob из ArrayBuffer). */
export async function encryptMediaBytes(plain: Uint8Array): Promise<{
  cipher: Uint8Array;
  keyBase64Url: string;
  nonceBase64Url: string;
}> {
  const keyBytes = randomBytes(32);
  const nonce = randomBytes(12);
  const key = await subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["encrypt"]);
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(plain),
  );
  return {
    cipher: new Uint8Array(cipher),
    keyBase64Url: toBase64Url(keyBytes),
    nonceBase64Url: toBase64Url(nonce),
  };
}

export async function encryptVoiceBlob(blob: Blob): Promise<{
  encryptedBlob: Blob;
  keyBase64Url: string;
  nonceBase64Url: string;
}> {
  const keyBytes = randomBytes(32);
  const nonce = randomBytes(12);
  const key = await subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["encrypt"]);
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    key,
    await blob.arrayBuffer(),
  );
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
  const plain = await decryptMediaBytes({
    cipher: await params.encryptedBlob.arrayBuffer(),
    keyBase64Url: params.keyBase64Url,
    nonceBase64Url: params.nonceBase64Url,
  });
  return new Blob([new Uint8Array(plain)], { type: params.contentType || "audio/aac" });
}

/** Расшифровка медиа без промежуточного Blob (надёжнее на Hermes). */
export async function decryptMediaBytes(params: {
  cipher: ArrayBuffer;
  keyBase64Url: string;
  nonceBase64Url: string;
}): Promise<Uint8Array> {
  const keyBytes = fromBase64Url(params.keyBase64Url);
  const nonce = fromBase64Url(params.nonceBase64Url);
  const key = await subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["decrypt"]);
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    key,
    params.cipher,
  );
  return new Uint8Array(plain);
}
