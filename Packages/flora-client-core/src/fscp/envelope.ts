import { floraNewUuid } from "./floraUuid.js";
import { FSCP_BOOTSTRAP_DEVICE_UUID, FSCP_BOOTSTRAP_KEY_EPOCH_ID, FSCP_WIRE_PREFIX } from "./constants.js";
import { agreementPublicKeyId, dmConversationUuid } from "./deriveIds.js";
import { messageBodyAadLine, recipientKeyEnvelopeAadLine } from "./aad.js";
import { canonicalJson } from "./canonicalJson.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { rkeUnwrapMessageKey, rkeWrapMessageKey } from "./rke.js";
import { getSodium, scalarmultBase } from "./sodium.js";
const VARIANT = 7; // sodium_base64_VARIANT_URLSAFE_NO_PADDING

export type FscpRecipientKeyEnvelopeWire = {
  version: number;
  algorithm: "x25519-hkdf-xchacha20poly1305";
  ephemeralPublicKeyBase64Url: string;
  recipientAgreementPublicKeyId: string;
  preKeyId: string | null;
  saltBase64Url: string;
  aead: { name: "xchacha20-poly1305"; nonceBase64Url: string };
  ciphertextBase64Url: string;
};

export type FscpRecipientWire = {
  userUuid: string;
  deviceUuid: string;
  recipientKeyEnvelope: FscpRecipientKeyEnvelopeWire;
};

export type FscpEnvelopeWire = {
  version: number;
  messageUuid: string;
  conversationUuid: string;
  keyEpochId: string;
  senderUserUuid: string;
  senderDeviceUuid: string;
  messageKeyId: string;
  createdAt: string;
  ciphertextBase64Url: string;
  aead: { name: "xchacha20-poly1305"; nonceBase64Url: string };
  recipients: FscpRecipientWire[];
  /** Ed25519 публичный ключ подписи отправителя (32 байта, base64url). Обязателен для новых wire; старые сообщения могут не содержать поле. */
  senderSigningPublicKeyBase64Url?: string;
  senderSignatureBase64Url: string;
};

export type FscpTextBlock = {
  kind: "text";
  body: string;
};

export type FscpVoiceBlock = {
  kind: "voice";
  assetUuid: string;
  durationMs: number;
  waveform: number[];
  contentType: string;
  encryption: {
    algorithm: "aes-gcm";
    keyBase64Url: string;
    nonceBase64Url: string;
  };
};

export type FscpImageBlock = {
  kind: "image";
  assetUuid: string;
  contentType: string;
  encryption: {
    algorithm: "aes-gcm";
    keyBase64Url: string;
    nonceBase64Url: string;
  };
};

export type FscpVideoBlock = {
  kind: "video";
  assetUuid: string;
  contentType: string;
  durationMs: number;
  width: number;
  height: number;
  encryption: {
    algorithm: "aes-gcm";
    keyBase64Url: string;
    nonceBase64Url: string;
  };
};

export type FscpMessageBlock = FscpTextBlock | FscpVoiceBlock | FscpImageBlock | FscpVideoBlock;

/** Ссылка на сообщение, на которое отвечают (денормализованный превью, как в TG). */
export type FscpMessageReplyRef = {
  messageUuid: string;
  authorDisplayName: string;
  preview: string;
};

export type FscpMessagePlaintext = {
  type: "blocks";
  version: 1;
  blocks: FscpMessageBlock[];
  clientCreatedAt: string;
  replyTo?: FscpMessageReplyRef;
};

function normalizeReplyRef(raw: unknown): FscpMessageReplyRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.messageUuid !== "string") return undefined;
  if (typeof r.authorDisplayName !== "string") return undefined;
  if (typeof r.preview !== "string") return undefined;
  return {
    messageUuid: r.messageUuid,
    authorDisplayName: r.authorDisplayName,
    preview: r.preview,
  };
}

function normalizePlaintextPayload(raw: unknown): FscpMessagePlaintext {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!obj) throw new Error("Неверный plaintext сообщения.");

  if (obj.type === "text" && typeof obj.body === "string") {
    const replyTo = normalizeReplyRef(obj.replyTo);
    return {
      type: "blocks",
      version: 1,
      blocks: [{ kind: "text", body: obj.body }],
      clientCreatedAt: typeof obj.clientCreatedAt === "string" ? obj.clientCreatedAt : new Date().toISOString(),
      ...(replyTo ? { replyTo } : {}),
    };
  }

  if (obj.type !== "blocks" || !Array.isArray(obj.blocks)) {
    throw new Error("Неверный plaintext сообщения.");
  }

  const blocks: FscpMessageBlock[] = [];
  for (const block of obj.blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.kind === "text" && typeof b.body === "string") {
      blocks.push({ kind: "text", body: b.body });
      continue;
    }
    const enc = b.encryption && typeof b.encryption === "object" ? (b.encryption as Record<string, unknown>) : null;
    if (
      b.kind === "voice" &&
      typeof b.assetUuid === "string" &&
      typeof b.durationMs === "number" &&
      typeof b.contentType === "string" &&
      enc?.algorithm === "aes-gcm" &&
      typeof enc.keyBase64Url === "string" &&
      typeof enc.nonceBase64Url === "string"
    ) {
      blocks.push({
        kind: "voice",
        assetUuid: b.assetUuid,
        durationMs: b.durationMs,
        waveform: Array.isArray(b.waveform) ? b.waveform.filter((x): x is number => typeof x === "number") : [],
        contentType: b.contentType,
        encryption: {
          algorithm: "aes-gcm",
          keyBase64Url: enc.keyBase64Url,
          nonceBase64Url: enc.nonceBase64Url,
        },
      });
      continue;
    }
    if (
      b.kind === "image" &&
      typeof b.assetUuid === "string" &&
      typeof b.contentType === "string" &&
      enc?.algorithm === "aes-gcm" &&
      typeof enc.keyBase64Url === "string" &&
      typeof enc.nonceBase64Url === "string"
    ) {
      blocks.push({
        kind: "image",
        assetUuid: b.assetUuid,
        contentType: b.contentType,
        encryption: {
          algorithm: "aes-gcm",
          keyBase64Url: enc.keyBase64Url,
          nonceBase64Url: enc.nonceBase64Url,
        },
      });
      continue;
    }
    if (
      b.kind === "video" &&
      typeof b.assetUuid === "string" &&
      typeof b.contentType === "string" &&
      enc?.algorithm === "aes-gcm" &&
      typeof enc.keyBase64Url === "string" &&
      typeof enc.nonceBase64Url === "string"
    ) {
      blocks.push({
        kind: "video",
        assetUuid: b.assetUuid,
        contentType: b.contentType,
        durationMs: typeof b.durationMs === "number" ? b.durationMs : 0,
        width: typeof b.width === "number" ? b.width : 0,
        height: typeof b.height === "number" ? b.height : 0,
        encryption: {
          algorithm: "aes-gcm",
          keyBase64Url: enc.keyBase64Url,
          nonceBase64Url: enc.nonceBase64Url,
        },
      });
    }
  }

  const replyTo = normalizeReplyRef(obj.replyTo);
  return {
    type: "blocks",
    version: 1,
    blocks,
    clientCreatedAt: typeof obj.clientCreatedAt === "string" ? obj.clientCreatedAt : new Date().toISOString(),
    ...(replyTo ? { replyTo } : {}),
  };
}

function sortRecipients(rec: FscpRecipientWire[]): FscpRecipientWire[] {
  return [...rec].sort((a, b) => {
    const c = a.userUuid.toLowerCase().localeCompare(b.userUuid.toLowerCase());
    if (c !== 0) return c;
    return a.deviceUuid.toLowerCase().localeCompare(b.deviceUuid.toLowerCase());
  });
}

function envelopeWireForSigning(env: FscpEnvelopeWire): Omit<FscpEnvelopeWire, "senderSignatureBase64Url"> {
  const { senderSignatureBase64Url: _omit, ...rest } = env;
  return rest;
}

async function verifyDetachedEnvelopeSignature(sodium: Awaited<ReturnType<typeof getSodium>>, env: FscpEnvelopeWire): Promise<void> {
  const pkB64 = env.senderSigningPublicKeyBase64Url;
  if (!pkB64 || pkB64.trim().length === 0) return;
  const signPayload = utf8Bytes(`flora.messaging.envelope-signature.v1 | ${canonicalJson(envelopeWireForSigning(env))}`);
  const sig = fromBase64Url(env.senderSignatureBase64Url);
  const pk = fromBase64Url(pkB64);
  if (!sodium.crypto_sign_verify_detached(sig, signPayload, pk)) {
    throw new Error("Подпись конверта не прошла проверку.");
  }
}

export async function buildFscpWireEnvelope(params: {
  senderUserUuid: string;
  receiverUserUuid: string;
  senderAgreementPrivateKey: Uint8Array;
  senderSigningPrivateKey: Uint8Array;
  receiverAgreementPublicKey: Uint8Array;
  messageBody?: string;
  messagePayload?: FscpMessagePlaintext;
}): Promise<string> {
  const sodium = await getSodium();
  const messageUuid = floraNewUuid();
  const messageKeyId = floraNewUuid();
  const createdAt = new Date().toISOString();
  const keyEpochId = FSCP_BOOTSTRAP_KEY_EPOCH_ID;
  const conversationUuid = dmConversationUuid(params.senderUserUuid, params.receiverUserUuid);
  const senderDeviceUuid = FSCP_BOOTSTRAP_DEVICE_UUID;
  const receiverDeviceUuid = FSCP_BOOTSTRAP_DEVICE_UUID;
  const senderAgreementPublic = scalarmultBase(sodium, params.senderAgreementPrivateKey);
  const senderAgreementPublicKeyId = agreementPublicKeyId(params.senderUserUuid, keyEpochId);
  const receiverAgreementPublicKeyId = agreementPublicKeyId(params.receiverUserUuid, keyEpochId);

  const messageKey = sodium.randombytes_buf(32);
  const plaintextObj =
    params.messagePayload ??
    ({
      type: "blocks",
      version: 1,
      blocks: [{ kind: "text", body: params.messageBody ?? "" }],
      clientCreatedAt: createdAt,
    } satisfies FscpMessagePlaintext);
  const plaintextUtf8 = JSON.stringify(plaintextObj);
  const bodyAad = messageBodyAadLine({
    conversationUuid,
    keyEpochId,
    messageUuid,
    messageKeyId,
    senderUserUuid: params.senderUserUuid,
    senderDeviceUuid,
    createdAt,
  });
  const bodyNonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const bodyCipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    utf8Bytes(plaintextUtf8),
    bodyAad,
    null,
    bodyNonce,
    messageKey
  );

  function oneRke(recipientUserUuid: string, recipientDeviceUuid: string, recipientAgreementPublicKey: Uint8Array, recipientAgreementId: string) {
    const ephemeralSecret = sodium.randombytes_buf(32);
    const salt32 = sodium.randombytes_buf(32);
    const aadLine = recipientKeyEnvelopeAadLine({
      conversationUuid,
      keyEpochId,
      messageUuid,
      messageKeyId,
      senderUserUuid: params.senderUserUuid,
      senderDeviceUuid,
      recipientUserUuid,
      recipientDeviceUuid,
      recipientAgreementPublicKeyId: recipientAgreementId,
    });
    const w = rkeWrapMessageKey({
      sodium,
      ephemeralSecret,
      recipientAgreementPublicKey: recipientAgreementPublicKey,
      salt32,
      aadUtf8Line: aadLine,
      messageKey32: messageKey,
    });
    return {
      userUuid: recipientUserUuid,
      deviceUuid: recipientDeviceUuid,
      recipientKeyEnvelope: {
        version: 1,
        algorithm: "x25519-hkdf-xchacha20poly1305" as const,
        ephemeralPublicKeyBase64Url: sodium.to_base64(w.ephemeralPublicKey, VARIANT),
        recipientAgreementPublicKeyId: recipientAgreementId,
        preKeyId: null,
        saltBase64Url: sodium.to_base64(salt32, VARIANT),
        aead: {
          name: "xchacha20-poly1305" as const,
          nonceBase64Url: sodium.to_base64(w.nonce, VARIANT),
        },
        ciphertextBase64Url: sodium.to_base64(w.ciphertext, VARIANT),
      } satisfies FscpRecipientKeyEnvelopeWire,
    } satisfies FscpRecipientWire;
  }

  const recA = oneRke(
    params.receiverUserUuid,
    receiverDeviceUuid,
    params.receiverAgreementPublicKey,
    receiverAgreementPublicKeyId
  );
  const recB = oneRke(params.senderUserUuid, senderDeviceUuid, senderAgreementPublic, senderAgreementPublicKeyId);
  const recipients = sortRecipients([recA, recB]);

  const signSeed = params.senderSigningPrivateKey.subarray(0, 32);
  const signingPublicKey =
    sodium.crypto_sign_seed_keypair?.(signSeed).publicKey ??
    (params.senderSigningPrivateKey.byteLength >= 64
      ? params.senderSigningPrivateKey.subarray(32, 64)
      : sodium.crypto_sign_keypair().publicKey);

  const envelopeNoSig: Omit<FscpEnvelopeWire, "senderSignatureBase64Url"> = {
    version: 1,
    messageUuid,
    conversationUuid,
    keyEpochId,
    senderUserUuid: params.senderUserUuid,
    senderDeviceUuid,
    messageKeyId,
    createdAt,
    ciphertextBase64Url: sodium.to_base64(bodyCipher, VARIANT),
    aead: { name: "xchacha20-poly1305", nonceBase64Url: sodium.to_base64(bodyNonce, VARIANT) },
    recipients,
    senderSigningPublicKeyBase64Url: sodium.to_base64(signingPublicKey, VARIANT),
  };

  const signPayload = utf8Bytes(`flora.messaging.envelope-signature.v1 | ${canonicalJson(envelopeNoSig)}`);
  const sig = sodium.crypto_sign_detached(signPayload, params.senderSigningPrivateKey);
  const full: FscpEnvelopeWire = { ...envelopeNoSig, senderSignatureBase64Url: sodium.to_base64(sig, VARIANT) };

  const json = JSON.stringify(full);
  const wire = `${FSCP_WIRE_PREFIX}${sodium.to_base64(utf8Bytes(json), VARIANT)}`;
  return wire;
}

export async function decryptFscpWireEnvelope(params: {
  wire: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
}): Promise<FscpMessagePlaintext> {
  if (!params.wire.startsWith(FSCP_WIRE_PREFIX)) {
    throw new Error("Не FSCP wire.");
  }
  const sodium = await getSodium();
  const raw = fromBase64Url(params.wire.slice(FSCP_WIRE_PREFIX.length));
  const json = new TextDecoder().decode(raw);
  const env = JSON.parse(json) as FscpEnvelopeWire;

  await verifyDetachedEnvelopeSignature(sodium, env);

  const meNorm = params.viewerUserUuid.trim().toLowerCase();
  const row = env.recipients.find((r) => r.userUuid.trim().toLowerCase() === meNorm);
  if (!row) throw new Error("Нет RKE для этого пользователя.");

  const rke = row.recipientKeyEnvelope;
  const aadLine = recipientKeyEnvelopeAadLine({
    conversationUuid: env.conversationUuid,
    keyEpochId: env.keyEpochId,
    messageUuid: env.messageUuid,
    messageKeyId: env.messageKeyId,
    senderUserUuid: env.senderUserUuid,
    senderDeviceUuid: env.senderDeviceUuid,
    recipientUserUuid: row.userUuid,
    recipientDeviceUuid: row.deviceUuid,
    recipientAgreementPublicKeyId: rke.recipientAgreementPublicKeyId,
  });
  const messageKey = rkeUnwrapMessageKey({
    sodium,
    agreementPrivateKey: params.agreementPrivateKey,
    ephemeralPublicKey: fromBase64Url(rke.ephemeralPublicKeyBase64Url),
    salt32: fromBase64Url(rke.saltBase64Url),
    aadUtf8Line: aadLine,
    nonce: fromBase64Url(rke.aead.nonceBase64Url),
    ciphertext: fromBase64Url(rke.ciphertextBase64Url),
  });

  const bodyAad = messageBodyAadLine({
    conversationUuid: env.conversationUuid,
    keyEpochId: env.keyEpochId,
    messageUuid: env.messageUuid,
    messageKeyId: env.messageKeyId,
    senderUserUuid: env.senderUserUuid,
    senderDeviceUuid: env.senderDeviceUuid,
    createdAt: env.createdAt,
  });
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromBase64Url(env.ciphertextBase64Url),
    bodyAad,
    fromBase64Url(env.aead.nonceBase64Url),
    messageKey
  );
  return normalizePlaintextPayload(JSON.parse(new TextDecoder().decode(plain)));
}

export function isFscpWirePayload(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(FSCP_WIRE_PREFIX);
}
