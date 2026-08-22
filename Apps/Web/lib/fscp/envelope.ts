import { computeFrankTagV1, frankCommitInputV1 } from "@flora/client-core/fscp";
import { floraNewUuid } from "../floraUuid";
import { FSCP_BOOTSTRAP_DEVICE_UUID, FSCP_BOOTSTRAP_KEY_EPOCH_ID, FSCP_WIRE_PREFIX } from "./constants";
import { agreementPublicKeyId, dmConversationUuid } from "./deriveIds";
import { messageBodyAadLine, recipientKeyEnvelopeAadLine } from "./aad";
import { canonicalJson, compareCodeUnits } from "./canonicalJson";
import { fromBase64Url, utf8Bytes } from "./base64url";
import { rkeUnwrapMessageKey, rkeWrapMessageKey } from "./rke";
import { getSodium } from "./sodium";
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
  /** FSCP-FRANK v1.1+: HMAC-тег. Отсутствует на замороженном v1. */
  frankTagBase64Url?: string;
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

/**
 * Блок неизвестного вида из более новой версии схемы plaintext (forward-compat,
 * FSCP.md errata-5): сохраняется как placeholder вместо молчаливого отбрасывания.
 */
export type FscpUnknownBlock = {
  kind: "unknown";
  originalKind: string;
};

export type FscpMessageBlock =
  | FscpTextBlock
  | FscpVoiceBlock
  | FscpImageBlock
  | FscpVideoBlock
  | FscpUnknownBlock;

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
      continue;
    }
    // Forward-compat: неизвестный kind не отбрасывается молча (FSCP-REVIEW п.5).
    if (typeof b.kind === "string" && b.kind.length > 0) {
      blocks.push({ kind: "unknown", originalKind: b.kind });
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
    const c = compareCodeUnits(a.userUuid.toLowerCase(), b.userUuid.toLowerCase());
    if (c !== 0) return c;
    return compareCodeUnits(a.deviceUuid.toLowerCase(), b.deviceUuid.toLowerCase());
  });
}

/** Категории сбоев decrypt — зеркало @flora/fscp (FSCP.md errata-5). */
export type FscpDecryptFailureCategory =
  | "not_fscp_wire"
  | "malformed_envelope"
  | "signature_missing"
  | "signature_invalid"
  | "no_recipient_entry"
  | "rke_unwrap_failed"
  | "body_decrypt_failed"
  | "malformed_plaintext";

export class FscpDecryptError extends Error {
  readonly category: FscpDecryptFailureCategory;

  constructor(category: FscpDecryptFailureCategory, message: string) {
    super(message);
    this.name = "FscpDecryptError";
    this.category = category;
  }
}

export function fscpDecryptFailureCategory(error: unknown): FscpDecryptFailureCategory {
  return error instanceof FscpDecryptError ? error.category : "malformed_envelope";
}

// Паддинг plaintext до бакетов (скрытие длины) — зеркало @flora/fscp, errata-5.
const PAD_FIELD_OVERHEAD_BYTES = 9;

export function fscpPlaintextBucketBytes(rawUtf8Length: number): number {
  const withOverhead = rawUtf8Length + PAD_FIELD_OVERHEAD_BYTES;
  const step = withOverhead <= 4096 ? 256 : 1024;
  return Math.ceil(withOverhead / step) * step;
}

export function padPlaintextJsonV1(compactJson: string): string {
  if (!compactJson.endsWith("}")) return compactJson;
  const rawLen = utf8Bytes(compactJson).byteLength;
  const padLen = fscpPlaintextBucketBytes(rawLen) - rawLen - PAD_FIELD_OVERHEAD_BYTES;
  return `${compactJson.slice(0, -1)},"pad":"${"0".repeat(padLen)}"}`;
}

function envelopeWireForSigning(env: FscpEnvelopeWire): Omit<FscpEnvelopeWire, "senderSignatureBase64Url"> {
  const { senderSignatureBase64Url: _omit, ...rest } = env;
  return rest;
}

async function verifyDetachedEnvelopeSignature(
  sodium: Awaited<ReturnType<typeof getSodium>>,
  env: FscpEnvelopeWire,
  allowUnsignedLegacy: boolean,
): Promise<void> {
  const pkB64 = env.senderSigningPublicKeyBase64Url;
  if (!pkB64 || pkB64.trim().length === 0) {
    // Errata-5: неподписанные конверты отклоняются (downgrade-защита).
    if (allowUnsignedLegacy) return;
    throw new FscpDecryptError(
      "signature_missing",
      "Конверт без подписи отклонён (downgrade-защита). Для архивных сообщений используйте allowUnsignedLegacy.",
    );
  }
  const signPayload = utf8Bytes(`flora.messaging.envelope-signature.v1 | ${canonicalJson(envelopeWireForSigning(env))}`);
  let ok = false;
  try {
    const sig = fromBase64Url(env.senderSignatureBase64Url);
    const pk = fromBase64Url(pkB64);
    ok = sodium.crypto_sign_verify_detached(sig, signPayload, pk);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new FscpDecryptError("signature_invalid", "Подпись конверта не прошла проверку.");
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
  /**
   * FSCP-FRANK v1.1 (franking.md §4.1–4.2): эмитировать `frankTag` и положить
   * per-message `frankingKey` в plaintext. Решение продуктовое — принимает
   * вызывающая сторона (Web / Mobile), ядро своей конфигурации не имеет.
   * По умолчанию выключено: конверт и plaintext побайтово остаются v1.
   * Группы и organizer не франкуются (§4.6) — у них свой путь сборки.
   */
  emitFrankTag?: boolean;
}): Promise<string> {
  const sodium = await getSodium();
  const messageUuid = floraNewUuid();
  const messageKeyId = floraNewUuid();
  const createdAt = new Date().toISOString();
  const keyEpochId = FSCP_BOOTSTRAP_KEY_EPOCH_ID;
  const conversationUuid = dmConversationUuid(params.senderUserUuid, params.receiverUserUuid);
  const senderDeviceUuid = FSCP_BOOTSTRAP_DEVICE_UUID;
  const receiverDeviceUuid = FSCP_BOOTSTRAP_DEVICE_UUID;
  const senderAgreementPublic = sodium.crypto_scalarmult_base(params.senderAgreementPrivateKey);
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
  // §4.1: Kf — 32 случайных байта на сообщение, едет получателю внутри шифртекста
  // соседом `blocks`; сервер его не видит. Паддинг накладывается уже поверх ключа.
  const frankingKey = params.emitFrankTag ? sodium.randombytes_buf(32) : null;
  const plaintextUtf8 = padPlaintextJsonV1(
    JSON.stringify(
      frankingKey
        ? { ...plaintextObj, frankingKeyBase64Url: sodium.to_base64(frankingKey, VARIANT) }
        : plaintextObj,
    ),
  );
  // §4.1: commitment — по ровно тем байтам, что уходят в AEAD, включая pad.
  const frankTagBase64Url = frankingKey
    ? sodium.to_base64(
        computeFrankTagV1(
          frankingKey,
          frankCommitInputV1(
            {
              conversationUuid,
              messageUuid,
              senderUserUuid: params.senderUserUuid,
              senderDeviceUuid,
              receiverUserUuid: params.receiverUserUuid,
              createdAt,
            },
            utf8Bytes(plaintextUtf8),
          ),
        ),
        VARIANT,
      )
    : null;
  const bodyAad = messageBodyAadLine({
    conversationUuid,
    keyEpochId,
    messageUuid,
    messageKeyId,
    senderUserUuid: params.senderUserUuid,
    senderDeviceUuid,
    createdAt,
    frankTagBase64Url,
  });
  const bodyNonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const bodyCipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    utf8Bytes(plaintextUtf8),
    utf8Bytes(bodyAad),
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
  const signingPublicKey = sodium.crypto_sign_seed_keypair(signSeed).publicKey;

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
    // §4.2: поле появляется только у франкованных сообщений и попадает в
    // canonical JSON до Ed25519 — подпись отправителя покрывает тег.
    ...(frankTagBase64Url ? { frankTagBase64Url } : {}),
  };

  const signPayload = utf8Bytes(`flora.messaging.envelope-signature.v1 | ${canonicalJson(envelopeNoSig)}`);
  const sig = sodium.crypto_sign_detached(signPayload, params.senderSigningPrivateKey);
  const full: FscpEnvelopeWire = { ...envelopeNoSig, senderSignatureBase64Url: sodium.to_base64(sig, VARIANT) };

  const json = JSON.stringify(full);
  const wire = `${FSCP_WIRE_PREFIX}${sodium.to_base64(utf8Bytes(json), VARIANT)}`;
  return wire;
}

/**
 * Тег из уже разобранного конверта. Конверт приходит из сети как `unknown`,
 * поэтому нестроковое/пустое поле — то же самое, что отсутствие тега (сообщение
 * читается как v1 и падает на AEAD, а не на TypeError вне классификации сбоев).
 */
function readOptionalFrankTagBase64Url(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const value = (parsed as Record<string, unknown>).frankTagBase64Url;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function decryptFscpWireEnvelope(params: {
  wire: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
  /** Читать конверты без подписи (архив). По умолчанию false — отклоняются. */
  allowUnsignedLegacy?: boolean;
}): Promise<FscpMessagePlaintext> {
  if (!params.wire.startsWith(FSCP_WIRE_PREFIX)) {
    throw new FscpDecryptError("not_fscp_wire", "Не FSCP wire.");
  }
  const sodium = await getSodium();
  let env: FscpEnvelopeWire;
  try {
    const raw = fromBase64Url(params.wire.slice(FSCP_WIRE_PREFIX.length));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as FscpEnvelopeWire).recipients)) {
      throw new Error("envelope shape");
    }
    env = parsed as FscpEnvelopeWire;
  } catch {
    throw new FscpDecryptError("malformed_envelope", "Повреждённый конверт FSCP (base64/JSON/форма).");
  }

  await verifyDetachedEnvelopeSignature(sodium, env, params.allowUnsignedLegacy ?? false);

  const meNorm = params.viewerUserUuid.trim().toLowerCase();
  const row = env.recipients.find((r) => r.userUuid.trim().toLowerCase() === meNorm);
  if (!row) throw new FscpDecryptError("no_recipient_entry", "Нет RKE для этого пользователя.");

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
  let messageKey: Uint8Array;
  try {
    messageKey = rkeUnwrapMessageKey({
      sodium,
      agreementPrivateKey: params.agreementPrivateKey,
      ephemeralPublicKey: fromBase64Url(rke.ephemeralPublicKeyBase64Url),
      salt32: fromBase64Url(rke.saltBase64Url),
      aadUtf8Line: aadLine,
      nonce: fromBase64Url(rke.aead.nonceBase64Url),
      ciphertext: fromBase64Url(rke.ciphertextBase64Url),
    });
  } catch {
    throw new FscpDecryptError(
      "rke_unwrap_failed",
      "Не удалось развернуть ключ сообщения (RKE): вероятно, ключ согласования устройства не совпадает.",
    );
  }

  // Тег на конверте → AAD версии v1_1 с суффиксом (franking.md §4.2); без тега — v1.
  const bodyAad = messageBodyAadLine({
    conversationUuid: env.conversationUuid,
    keyEpochId: env.keyEpochId,
    messageUuid: env.messageUuid,
    messageKeyId: env.messageKeyId,
    senderUserUuid: env.senderUserUuid,
    senderDeviceUuid: env.senderDeviceUuid,
    createdAt: env.createdAt,
    frankTagBase64Url: readOptionalFrankTagBase64Url(env),
  });
  let plain: Uint8Array;
  try {
    plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(env.ciphertextBase64Url),
      utf8Bytes(bodyAad),
      fromBase64Url(env.aead.nonceBase64Url),
      messageKey
    );
  } catch {
    throw new FscpDecryptError("body_decrypt_failed", "AEAD тела сообщения не расшифровался (ключ/AAD не совпали).");
  }
  try {
    return normalizePlaintextPayload(JSON.parse(new TextDecoder().decode(plain)));
  } catch {
    throw new FscpDecryptError("malformed_plaintext", "Расшифрованный plaintext сообщения имеет неверную форму.");
  }
}

export function isFscpWirePayload(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(FSCP_WIRE_PREFIX);
}

/** Envelope `frankTag` without decrypt (franking.md §4.3). Missing/malformed wire → null. */
export function peekFscpWireFrankTagBase64Url(wire: string | null | undefined): string | null {
  if (typeof wire !== "string" || !wire.startsWith(FSCP_WIRE_PREFIX)) return null;
  try {
    const raw = fromBase64Url(wire.slice(FSCP_WIRE_PREFIX.length));
    return readOptionalFrankTagBase64Url(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    return null;
  }
}
