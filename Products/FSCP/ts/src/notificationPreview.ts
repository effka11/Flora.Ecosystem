import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { canonicalJson } from "./canonicalJson.js";
import { floraNewUuid } from "./floraUuid.js";
import { getSodium, scalarmult, scalarmultBase } from "./sodium.js";

export const FSCP_NOTIFICATION_PREVIEW_WIRE_PREFIX = "fscpnp1:";
export const FSCP_NOTIFICATION_PREVIEW_VERSION = 1;
export const FSCP_NOTIFICATION_PREVIEW_MAX_CHARS = 120;
export const FSCP_NOTIFICATION_PREVIEW_MAX_WIRE_BYTES = 2_700;
export const FSCP_NOTIFICATION_PREVIEW_TTL_MS = 24 * 60 * 60 * 1_000;

const AAD_DOMAIN = "flora.notifications.message-preview.v1";
const SIGNATURE_DOMAIN = "flora.notifications.message-preview-signature.v1";

export type NotificationPreviewKind = "text" | "photo" | "voice" | "video" | "mixed";

export type NotificationPreviewEnvelopeV1 = {
  version: 1;
  previewId: string;
  wireMessageUuid: string;
  wireSha256Base64Url: string;
  conversationUuid: string;
  senderUserUuid: string;
  recipientUserUuid: string;
  recipientInstallationUuid: string;
  previewKeyId: string;
  issuedAt: string;
  expiresAt: string;
  ephemeralPublicKeyBase64Url: string;
  saltBase64Url: string;
  aead: {
    name: "xchacha20-poly1305";
    nonceBase64Url: string;
  };
  ciphertextBase64Url: string;
  senderSigningPublicKeyBase64Url: string;
  senderSignatureBase64Url: string;
};

export type NotificationPreviewPlaintextV1 = {
  preview: string;
  kind: NotificationPreviewKind;
};

type PaddedNotificationPreviewPlaintextV1 = NotificationPreviewPlaintextV1 & {
  pad: string;
};

type MessageWireMetadata = {
  messageUuid: string;
  conversationUuid: string;
  senderUserUuid: string;
  senderSigningPublicKeyBase64Url: string;
};

function base64Url(bytes: Uint8Array, sodium: Awaited<ReturnType<typeof getSodium>>): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function decodeMessageWireMetadata(wire: string): MessageWireMetadata {
  if (!wire.startsWith("fscp1:")) throw new Error("Notification preview: main wire is not FSCP v1.");
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(fromBase64Url(wire.slice("fscp1:".length))),
  );
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Notification preview: malformed main wire.");
  }
  const value = parsed as Record<string, unknown>;
  const read = (key: string): string => {
    const field = value[key];
    if (typeof field !== "string" || field.trim().length === 0) {
      throw new Error(`Notification preview: main wire has no ${key}.`);
    }
    return field.trim();
  };
  return {
    messageUuid: read("messageUuid"),
    conversationUuid: read("conversationUuid"),
    senderUserUuid: read("senderUserUuid"),
    senderSigningPublicKeyBase64Url: read("senderSigningPublicKeyBase64Url"),
  };
}

export function notificationPreviewAadLine(
  env: Pick<
    NotificationPreviewEnvelopeV1,
    | "previewId"
    | "wireMessageUuid"
    | "wireSha256Base64Url"
    | "conversationUuid"
    | "senderUserUuid"
    | "recipientUserUuid"
    | "recipientInstallationUuid"
    | "previewKeyId"
    | "issuedAt"
    | "expiresAt"
  >,
): string {
  return [
    AAD_DOMAIN,
    env.previewId.toLowerCase(),
    env.wireMessageUuid.toLowerCase(),
    env.wireSha256Base64Url,
    env.conversationUuid.toLowerCase(),
    env.senderUserUuid.toLowerCase(),
    env.recipientUserUuid.toLowerCase(),
    env.recipientInstallationUuid.toLowerCase(),
    env.previewKeyId.toLowerCase(),
    env.issuedAt,
    env.expiresAt,
  ].join(" | ");
}

function withoutSignature(
  env: NotificationPreviewEnvelopeV1,
): Omit<NotificationPreviewEnvelopeV1, "senderSignatureBase64Url"> {
  const { senderSignatureBase64Url: _signature, ...rest } = env;
  return rest;
}

function signaturePayload(env: Omit<NotificationPreviewEnvelopeV1, "senderSignatureBase64Url">): Uint8Array {
  return utf8Bytes(`${SIGNATURE_DOMAIN} | ${canonicalJson(env)}`);
}

function truncatePreview(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  const chars = Array.from(normalized);
  return chars.length <= FSCP_NOTIFICATION_PREVIEW_MAX_CHARS
    ? normalized
    : chars.slice(0, FSCP_NOTIFICATION_PREVIEW_MAX_CHARS - 1).join("") + "…";
}

export async function buildNotificationPreviewEnvelope(params: {
  messageWire: string;
  recipientUserUuid: string;
  recipientInstallationUuid: string;
  previewKeyId: string;
  recipientPreviewPublicKey: Uint8Array;
  senderSigningPrivateKey: Uint8Array;
  preview: string;
  kind: NotificationPreviewKind;
  issuedAt?: string;
  /** Deterministic inputs reserved for generated golden vectors. */
  vectorOverrides?: {
    previewId: string;
    ephemeralSecret: Uint8Array;
    salt: Uint8Array;
    nonce: Uint8Array;
  };
}): Promise<string> {
  const sodium = await getSodium();
  const metadata = decodeMessageWireMetadata(params.messageWire);
  const signingSeed = params.senderSigningPrivateKey.subarray(0, 32);
  const signingPublicKey =
    sodium.crypto_sign_seed_keypair?.(signingSeed).publicKey ??
    (params.senderSigningPrivateKey.byteLength >= 64
      ? params.senderSigningPrivateKey.subarray(32, 64)
      : undefined);
  if (!signingPublicKey) {
    throw new Error("Notification preview: sender signing public key is unavailable.");
  }
  const signingPublicKeyB64 = base64Url(signingPublicKey, sodium);
  if (signingPublicKeyB64 !== metadata.senderSigningPublicKeyBase64Url) {
    throw new Error("Notification preview: signing key does not match the main message wire.");
  }
  if (params.recipientPreviewPublicKey.byteLength !== 32) {
    throw new Error("Notification preview: recipient public key must be 32 bytes.");
  }

  const issuedAt = params.issuedAt ?? new Date().toISOString();
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs)) throw new Error("Notification preview: invalid issuedAt.");
  const expiresAt = new Date(issuedAtMs + FSCP_NOTIFICATION_PREVIEW_TTL_MS).toISOString();
  const binding = {
    previewId: params.vectorOverrides?.previewId ?? floraNewUuid(),
    wireMessageUuid: metadata.messageUuid.toLowerCase(),
    wireSha256Base64Url: base64Url(sha256(utf8Bytes(params.messageWire)), sodium),
    conversationUuid: metadata.conversationUuid.toLowerCase(),
    senderUserUuid: metadata.senderUserUuid.toLowerCase(),
    recipientUserUuid: params.recipientUserUuid.toLowerCase(),
    recipientInstallationUuid: params.recipientInstallationUuid.toLowerCase(),
    previewKeyId: params.previewKeyId.toLowerCase(),
    issuedAt,
    expiresAt,
  };
  const aad = notificationPreviewAadLine(binding);
  const ephemeralSecret = params.vectorOverrides?.ephemeralSecret ?? sodium.randombytes_buf(32);
  if (ephemeralSecret.byteLength !== 32) {
    throw new Error("Notification preview: ephemeral secret must be 32 bytes.");
  }
  const ephemeralPublicKey = scalarmultBase(sodium, ephemeralSecret);
  const salt = params.vectorOverrides?.salt ?? sodium.randombytes_buf(32);
  if (salt.byteLength !== 32) {
    throw new Error("Notification preview: salt must be 32 bytes.");
  }
  const sharedSecret = scalarmult(
    sodium,
    ephemeralSecret,
    params.recipientPreviewPublicKey,
  );
  const key = expand(
    sha256,
    extract(sha256, sharedSecret, salt),
    utf8Bytes(aad),
    32,
  );
  const nonce =
    params.vectorOverrides?.nonce ??
    sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  if (nonce.byteLength !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) {
    throw new Error("Notification preview: nonce must be 24 bytes.");
  }
  const plaintext: NotificationPreviewPlaintextV1 = {
    preview: truncatePreview(params.preview),
    kind: params.kind,
  };
  const basePlaintext: PaddedNotificationPreviewPlaintextV1 = { ...plaintext, pad: "" };
  const baseBytes = utf8Bytes(JSON.stringify(basePlaintext)).byteLength;
  const bucket = [128, 256, 512, 768].find((size) => size >= baseBytes);
  if (!bucket) throw new Error("Notification preview: plaintext exceeds padding buckets.");
  basePlaintext.pad = " ".repeat(bucket - baseBytes);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    utf8Bytes(JSON.stringify(basePlaintext)),
    aad,
    null,
    nonce,
    key,
  );
  const noSignature: Omit<NotificationPreviewEnvelopeV1, "senderSignatureBase64Url"> = {
    version: 1,
    ...binding,
    ephemeralPublicKeyBase64Url: base64Url(ephemeralPublicKey, sodium),
    saltBase64Url: base64Url(salt, sodium),
    aead: {
      name: "xchacha20-poly1305",
      nonceBase64Url: base64Url(nonce, sodium),
    },
    ciphertextBase64Url: base64Url(ciphertext, sodium),
    senderSigningPublicKeyBase64Url: signingPublicKeyB64,
  };
  const signature = sodium.crypto_sign_detached(
    signaturePayload(noSignature),
    params.senderSigningPrivateKey,
  );
  const wire = `${FSCP_NOTIFICATION_PREVIEW_WIRE_PREFIX}${base64Url(
    utf8Bytes(JSON.stringify({ ...noSignature, senderSignatureBase64Url: base64Url(signature, sodium) })),
    sodium,
  )}`;
  if (utf8Bytes(wire).byteLength > FSCP_NOTIFICATION_PREVIEW_MAX_WIRE_BYTES) {
    throw new Error("Notification preview: encrypted envelope exceeds the wire limit.");
  }
  return wire;
}

export async function buildNotificationPreviewBundle(params: {
  messageWire: string;
  recipientUserUuid: string;
  senderSigningPrivateKey: Uint8Array;
  preview: string;
  kind: NotificationPreviewKind;
  targets: Array<{
    installationUuid: string;
    previewKeyId: string;
    publicKeyBase64Url: string;
    protocolVersion: number;
  }>;
}): Promise<Array<{ installationUuid: string; previewKeyId: string; envelope: string }>> {
  const results = await Promise.all(
    params.targets
      .filter((target) => target.protocolVersion === 1)
      .slice(0, 8)
      .map(async (target) => ({
        installationUuid: target.installationUuid,
        previewKeyId: target.previewKeyId,
        envelope: await buildNotificationPreviewEnvelope({
          messageWire: params.messageWire,
          recipientUserUuid: params.recipientUserUuid,
          recipientInstallationUuid: target.installationUuid,
          previewKeyId: target.previewKeyId,
          recipientPreviewPublicKey: fromBase64Url(target.publicKeyBase64Url),
          senderSigningPrivateKey: params.senderSigningPrivateKey,
          preview: params.preview,
          kind: params.kind,
        }),
      })),
  );
  return results;
}

export function parseNotificationPreviewEnvelope(wire: string): NotificationPreviewEnvelopeV1 {
  if (!wire.startsWith(FSCP_NOTIFICATION_PREVIEW_WIRE_PREFIX)) {
    throw new Error("Notification preview: unsupported wire prefix.");
  }
  if (utf8Bytes(wire).byteLength > FSCP_NOTIFICATION_PREVIEW_MAX_WIRE_BYTES) {
    throw new Error("Notification preview: wire exceeds the size limit.");
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(
      fromBase64Url(wire.slice(FSCP_NOTIFICATION_PREVIEW_WIRE_PREFIX.length)),
    ),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Notification preview: malformed envelope.");
  }
  const env = parsed as NotificationPreviewEnvelopeV1;
  const expectedKeys = [
    "aead",
    "ciphertextBase64Url",
    "conversationUuid",
    "ephemeralPublicKeyBase64Url",
    "expiresAt",
    "issuedAt",
    "previewId",
    "previewKeyId",
    "recipientInstallationUuid",
    "recipientUserUuid",
    "saltBase64Url",
    "senderSignatureBase64Url",
    "senderSigningPublicKeyBase64Url",
    "senderUserUuid",
    "version",
    "wireMessageUuid",
    "wireSha256Base64Url",
  ];
  const actualKeys = Object.keys(parsed).sort();
  if (
    env.version !== FSCP_NOTIFICATION_PREVIEW_VERSION ||
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    !env.aead ||
    env.aead.name !== "xchacha20-poly1305" ||
    Object.keys(env.aead).sort().join(",") !== "name,nonceBase64Url"
  ) {
    throw new Error("Notification preview: unsupported envelope shape.");
  }
  for (const key of expectedKeys) {
    if (key === "version" || key === "aead") continue;
    if (typeof (env as unknown as Record<string, unknown>)[key] !== "string") {
      throw new Error(`Notification preview: ${key} must be a string.`);
    }
  }
  return env;
}

export async function openNotificationPreviewEnvelope(params: {
  wire: string;
  recipientUserUuid: string;
  recipientInstallationUuid: string;
  previewKeyId: string;
  recipientPreviewPrivateKey: Uint8Array;
  expectedSenderSigningPublicKeyBase64Url?: string;
  nowMs?: number;
}): Promise<NotificationPreviewPlaintextV1> {
  const sodium = await getSodium();
  const env = parseNotificationPreviewEnvelope(params.wire);
  if (
    env.recipientUserUuid.toLowerCase() !== params.recipientUserUuid.toLowerCase() ||
    env.recipientInstallationUuid.toLowerCase() !==
      params.recipientInstallationUuid.toLowerCase() ||
    env.previewKeyId.toLowerCase() !== params.previewKeyId.toLowerCase()
  ) {
    throw new Error("Notification preview: recipient binding mismatch.");
  }
  if (
    params.expectedSenderSigningPublicKeyBase64Url &&
    env.senderSigningPublicKeyBase64Url !==
      params.expectedSenderSigningPublicKeyBase64Url
  ) {
    throw new Error("Notification preview: sender signing key mismatch.");
  }
  const now = params.nowMs ?? Date.now();
  const issuedAt = Date.parse(env.issuedAt);
  const expiresAt = Date.parse(env.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > FSCP_NOTIFICATION_PREVIEW_TTL_MS ||
    issuedAt > now + 5 * 60 * 1_000 ||
    now > expiresAt
  ) {
    throw new Error("Notification preview: envelope is expired or has invalid timestamps.");
  }
  const signatureOk = sodium.crypto_sign_verify_detached(
    fromBase64Url(env.senderSignatureBase64Url),
    signaturePayload(withoutSignature(env)),
    fromBase64Url(env.senderSigningPublicKeyBase64Url),
  );
  if (!signatureOk) throw new Error("Notification preview: invalid sender signature.");

  const aad = notificationPreviewAadLine(env);
  const sharedSecret = scalarmult(
    sodium,
    params.recipientPreviewPrivateKey,
    fromBase64Url(env.ephemeralPublicKeyBase64Url),
  );
  const key = expand(
    sha256,
    extract(sha256, sharedSecret, fromBase64Url(env.saltBase64Url)),
    utf8Bytes(aad),
    32,
  );
  const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromBase64Url(env.ciphertextBase64Url),
    aad,
    fromBase64Url(env.aead.nonceBase64Url),
    key,
  );
  const plaintext: unknown = JSON.parse(new TextDecoder().decode(decrypted));
  if (!plaintext || typeof plaintext !== "object") {
    throw new Error("Notification preview: malformed plaintext.");
  }
  const value = plaintext as Record<string, unknown>;
  const validKinds: NotificationPreviewKind[] = ["text", "photo", "voice", "video", "mixed"];
  if (
    typeof value.preview !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.pad !== "string" ||
    Object.keys(value).sort().join(",") !== "kind,pad,preview" ||
    !validKinds.includes(value.kind as NotificationPreviewKind) ||
    Array.from(value.preview).length > FSCP_NOTIFICATION_PREVIEW_MAX_CHARS
  ) {
    throw new Error("Notification preview: malformed plaintext fields.");
  }
  return {
    preview: value.preview,
    kind: value.kind as NotificationPreviewKind,
  };
}
