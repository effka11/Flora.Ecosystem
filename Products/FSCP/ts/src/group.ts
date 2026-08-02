/**
 * FSCP-G v1 — групповой конверт (`fscpg1:`), отдельная спецификация поверх
 * криптопримитивов FSCP v1 (Documents/fscp/FSCP.md §Целевой алгоритм → Group messaging:
 * «отдельная спецификация, не смешивать с 1:1 сессией»).
 *
 * Замороженный DM-wire v1 (`fscp1:`) не изменяется. Групповой конверт использует
 * ту же проверенную криптографию (случайный 32-байтовый `messageKey`, per-recipient
 * RKE x25519-hkdf-xchacha20poly1305, Ed25519-подпись над canonical JSON, паддинг
 * plaintext до бакетов), но:
 *
 * - `recipients[]` — все активные участники группы (включая self-copy отправителя),
 *   1..=FSCP_GROUP_MAX_MEMBERS элементов;
 * - `conversationUuid` — server-issued UUID группы (не выводится из пары);
 * - новые AAD-метки `flora.messaging.group-*.v1` — доменное разделение: DM-конверт
 *   нельзя переиграть как групповой и наоборот (AAD ломает AEAD-tag);
 * - подпись — `flora.messaging.group-envelope-signature.v1`.
 *
 * Сервер (fscp-core `group.rs`) валидирует форму и подпись и сверяет состав
 * `recipients` с активным ростером группы, не расшифровывая payload.
 */

import { floraNewUuid } from "./floraUuid.js";
import { FSCP_BOOTSTRAP_DEVICE_UUID, FSCP_BOOTSTRAP_KEY_EPOCH_ID } from "./constants.js";
import { agreementPublicKeyId } from "./deriveIds.js";
import { canonicalJson, compareCodeUnits } from "./canonicalJson.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { rkeUnwrapMessageKey, rkeWrapMessageKey } from "./rke.js";
import { getSodium, scalarmultBase } from "./sodium.js";
import {
  FscpDecryptError,
  normalizeFscpMessagePlaintext,
  padPlaintextJsonV1,
  type FscpMessagePlaintext,
  type FscpRecipientKeyEnvelopeWire,
  type FscpRecipientWire,
} from "./envelope.js";

const VARIANT = 7; // sodium base64 URLSAFE_NO_PADDING

/** Префикс группового wire. Отличен от `fscp1:` — старые валидаторы его отклоняют целиком. */
export const FSCP_GROUP_WIRE_PREFIX = "fscpg1:";

/** Максимум участников группы v1 (включая отправителя). Согласован с fscp-core. */
export const FSCP_GROUP_MAX_MEMBERS = 128;

const GROUP_SIGNATURE_DOMAIN = "flora.messaging.group-envelope-signature.v1";

/** AAD тела группового сообщения — параллель `messageBodyAadLine`, свой домен. */
export function groupMessageBodyAadLine(params: {
  conversationUuid: string;
  keyEpochId: string;
  messageUuid: string;
  messageKeyId: string;
  senderUserUuid: string;
  senderDeviceUuid: string;
  createdAt: string;
}): string {
  const p = params;
  return [
    "flora.messaging.group-message.v1",
    p.conversationUuid.toLowerCase(),
    p.keyEpochId.toLowerCase(),
    p.messageUuid.toLowerCase(),
    p.messageKeyId.toLowerCase(),
    p.senderUserUuid.toLowerCase(),
    p.senderDeviceUuid.toLowerCase(),
    p.createdAt,
  ].join(" | ");
}

/** AAD RKE участника группы — параллель `recipientKeyEnvelopeAadLine`, свой домен. */
export function groupRecipientKeyEnvelopeAadLine(params: {
  conversationUuid: string;
  keyEpochId: string;
  messageUuid: string;
  messageKeyId: string;
  senderUserUuid: string;
  senderDeviceUuid: string;
  recipientUserUuid: string;
  recipientDeviceUuid: string;
  recipientAgreementPublicKeyId: string;
}): string {
  const p = params;
  return [
    "flora.messaging.group-recipient-key-envelope.v1",
    p.conversationUuid.toLowerCase(),
    p.keyEpochId.toLowerCase(),
    p.messageUuid.toLowerCase(),
    p.messageKeyId.toLowerCase(),
    p.senderUserUuid.toLowerCase(),
    p.senderDeviceUuid.toLowerCase(),
    p.recipientUserUuid.toLowerCase(),
    p.recipientDeviceUuid.toLowerCase(),
    p.recipientAgreementPublicKeyId.toLowerCase(),
  ].join(" | ");
}

/** Wire-форма группового конверта — та же структура полей, что у DM v1. */
export type FscpGroupEnvelopeWire = {
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
  senderSigningPublicKeyBase64Url?: string;
  senderSignatureBase64Url: string;
};

/** Участник-получатель при сборке (agreement public key берётся из справочника ключей). */
export type FscpGroupRecipientInput = {
  userUuid: string;
  agreementPublicKey: Uint8Array;
};

/** Метаданные успешно расшифрованного группового сообщения (из подписанного конверта). */
export type FscpGroupDecryptedMessage = {
  plaintext: FscpMessagePlaintext;
  conversationUuid: string;
  messageUuid: string;
  senderUserUuid: string;
  createdAt: string;
};

function sortRecipients(rec: FscpRecipientWire[]): FscpRecipientWire[] {
  return [...rec].sort((a, b) => {
    const c = compareCodeUnits(a.userUuid.toLowerCase(), b.userUuid.toLowerCase());
    if (c !== 0) return c;
    return compareCodeUnits(a.deviceUuid.toLowerCase(), b.deviceUuid.toLowerCase());
  });
}

function envelopeWireForSigning(
  env: FscpGroupEnvelopeWire,
): Omit<FscpGroupEnvelopeWire, "senderSignatureBase64Url"> {
  const { senderSignatureBase64Url: _omit, ...rest } = env;
  return rest;
}

/**
 * Сборка группового wire. Инварианты как в Algorithm A (FSCP.md): новый `messageKey`,
 * новый ephemeral, новая соль и nonce на каждую строку `recipients`; self-copy
 * отправителя добавляется автоматически (чтение собственной истории).
 */
export async function buildFscpGroupWireEnvelope(params: {
  conversationUuid: string;
  senderUserUuid: string;
  senderAgreementPrivateKey: Uint8Array;
  senderSigningPrivateKey: Uint8Array;
  /** Остальные активные участники группы (без отправителя; дубликаты отбрасываются). */
  recipients: readonly FscpGroupRecipientInput[];
  messagePayload?: FscpMessagePlaintext;
  messageBody?: string;
}): Promise<string> {
  const sodium = await getSodium();
  const conversationUuid = params.conversationUuid.trim().toLowerCase();
  if (!conversationUuid) throw new Error("FSCP-G: пустой conversationUuid группы.");
  const senderNorm = params.senderUserUuid.trim().toLowerCase();
  if (!senderNorm) throw new Error("FSCP-G: пустой senderUserUuid.");

  const seen = new Set<string>([senderNorm]);
  const others: FscpGroupRecipientInput[] = [];
  for (const r of params.recipients) {
    const norm = r.userUuid.trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    if (r.agreementPublicKey.byteLength !== 32) {
      throw new Error(`FSCP-G: неверная длина agreement public key участника ${norm}.`);
    }
    seen.add(norm);
    others.push({ userUuid: norm, agreementPublicKey: r.agreementPublicKey });
  }
  if (1 + others.length > FSCP_GROUP_MAX_MEMBERS) {
    throw new Error(`FSCP-G: больше ${FSCP_GROUP_MAX_MEMBERS} участников не поддерживается.`);
  }

  const messageUuid = floraNewUuid();
  const messageKeyId = floraNewUuid();
  const createdAt = new Date().toISOString();
  const keyEpochId = FSCP_BOOTSTRAP_KEY_EPOCH_ID;
  const senderDeviceUuid = FSCP_BOOTSTRAP_DEVICE_UUID;
  const senderAgreementPublic = scalarmultBase(sodium, params.senderAgreementPrivateKey);

  const messageKey = sodium.randombytes_buf(32);
  const plaintextObj =
    params.messagePayload ??
    ({
      type: "blocks",
      version: 1,
      blocks: [{ kind: "text", body: params.messageBody ?? "" }],
      clientCreatedAt: createdAt,
    } satisfies FscpMessagePlaintext);
  const plaintextUtf8 = padPlaintextJsonV1(JSON.stringify(plaintextObj));

  const bodyAad = groupMessageBodyAadLine({
    conversationUuid,
    keyEpochId,
    messageUuid,
    messageKeyId,
    senderUserUuid: senderNorm,
    senderDeviceUuid,
    createdAt,
  });
  const bodyNonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const bodyCipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    utf8Bytes(plaintextUtf8),
    bodyAad,
    null,
    bodyNonce,
    messageKey,
  );

  function oneRke(recipientUserUuid: string, recipientAgreementPublicKey: Uint8Array): FscpRecipientWire {
    const recipientAgreementId = agreementPublicKeyId(recipientUserUuid, keyEpochId);
    const ephemeralSecret = sodium.randombytes_buf(32);
    const salt32 = sodium.randombytes_buf(32);
    const aadLine = groupRecipientKeyEnvelopeAadLine({
      conversationUuid,
      keyEpochId,
      messageUuid,
      messageKeyId,
      senderUserUuid: senderNorm,
      senderDeviceUuid,
      recipientUserUuid,
      recipientDeviceUuid: FSCP_BOOTSTRAP_DEVICE_UUID,
      recipientAgreementPublicKeyId: recipientAgreementId,
    });
    const w = rkeWrapMessageKey({
      sodium,
      ephemeralSecret,
      recipientAgreementPublicKey,
      salt32,
      aadUtf8Line: aadLine,
      messageKey32: messageKey,
    });
    return {
      userUuid: recipientUserUuid,
      deviceUuid: FSCP_BOOTSTRAP_DEVICE_UUID,
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

  const entries = [
    oneRke(senderNorm, senderAgreementPublic),
    ...others.map((r) => oneRke(r.userUuid, r.agreementPublicKey)),
  ];
  const recipients = sortRecipients(entries);

  const signSeed = params.senderSigningPrivateKey.subarray(0, 32);
  const signingPublicKey =
    sodium.crypto_sign_seed_keypair?.(signSeed).publicKey ??
    (params.senderSigningPrivateKey.byteLength >= 64
      ? params.senderSigningPrivateKey.subarray(32, 64)
      : undefined);
  if (!signingPublicKey) {
    throw new Error(
      "FSCP-G: не удалось вывести публичный ключ подписи из senderSigningPrivateKey " +
        `(byteLength=${params.senderSigningPrivateKey.byteLength}).`,
    );
  }

  const envelopeNoSig: Omit<FscpGroupEnvelopeWire, "senderSignatureBase64Url"> = {
    version: 1,
    messageUuid,
    conversationUuid,
    keyEpochId,
    senderUserUuid: senderNorm,
    senderDeviceUuid,
    messageKeyId,
    createdAt,
    ciphertextBase64Url: sodium.to_base64(bodyCipher, VARIANT),
    aead: { name: "xchacha20-poly1305", nonceBase64Url: sodium.to_base64(bodyNonce, VARIANT) },
    recipients,
    senderSigningPublicKeyBase64Url: sodium.to_base64(signingPublicKey, VARIANT),
  };

  const signPayload = utf8Bytes(`${GROUP_SIGNATURE_DOMAIN} | ${canonicalJson(envelopeNoSig)}`);
  const sig = sodium.crypto_sign_detached(signPayload, params.senderSigningPrivateKey);
  const full: FscpGroupEnvelopeWire = {
    ...envelopeNoSig,
    senderSignatureBase64Url: sodium.to_base64(sig, VARIANT),
  };

  return `${FSCP_GROUP_WIRE_PREFIX}${sodium.to_base64(utf8Bytes(JSON.stringify(full)), VARIANT)}`;
}

async function verifyGroupEnvelopeSignature(
  sodium: Awaited<ReturnType<typeof getSodium>>,
  env: FscpGroupEnvelopeWire,
): Promise<void> {
  const pkB64 = env.senderSigningPublicKeyBase64Url;
  if (!pkB64 || pkB64.trim().length === 0) {
    // Группового legacy-архива не существует — неподписанный конверт всегда отклоняется.
    throw new FscpDecryptError("signature_missing", "Групповой конверт без подписи отклонён.");
  }
  const signPayload = utf8Bytes(
    `${GROUP_SIGNATURE_DOMAIN} | ${canonicalJson(envelopeWireForSigning(env))}`,
  );
  let ok = false;
  try {
    const sig = fromBase64Url(env.senderSignatureBase64Url);
    const pk = fromBase64Url(pkB64);
    ok = sodium.crypto_sign_verify_detached(sig, signPayload, pk);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new FscpDecryptError("signature_invalid", "Подпись группового конверта не прошла проверку.");
  }
}

export function isFscpGroupWirePayload(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(FSCP_GROUP_WIRE_PREFIX);
}

/** Открытие группового wire — зеркало Algorithm B с групповыми AAD-метками. */
export async function decryptFscpGroupWireEnvelope(params: {
  wire: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
}): Promise<FscpGroupDecryptedMessage> {
  if (!params.wire.startsWith(FSCP_GROUP_WIRE_PREFIX)) {
    throw new FscpDecryptError("not_fscp_wire", "Не FSCP-G wire.");
  }
  const sodium = await getSodium();
  let env: FscpGroupEnvelopeWire;
  try {
    const raw = fromBase64Url(params.wire.slice(FSCP_GROUP_WIRE_PREFIX.length));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as FscpGroupEnvelopeWire).recipients)
    ) {
      throw new Error("envelope shape");
    }
    env = parsed as FscpGroupEnvelopeWire;
  } catch {
    throw new FscpDecryptError("malformed_envelope", "Повреждённый групповой конверт (base64/JSON/форма).");
  }
  if (env.version !== 1) {
    throw new FscpDecryptError("malformed_envelope", "Неподдерживаемая версия группового конверта.");
  }

  await verifyGroupEnvelopeSignature(sodium, env);

  const meNorm = params.viewerUserUuid.trim().toLowerCase();
  const row = env.recipients.find((r) => r.userUuid.trim().toLowerCase() === meNorm);
  if (!row) throw new FscpDecryptError("no_recipient_entry", "Нет RKE для этого участника группы.");

  const rke = row.recipientKeyEnvelope;
  const aadLine = groupRecipientKeyEnvelopeAadLine({
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
      "Не удалось развернуть ключ группового сообщения (RKE).",
    );
  }

  const bodyAad = groupMessageBodyAadLine({
    conversationUuid: env.conversationUuid,
    keyEpochId: env.keyEpochId,
    messageUuid: env.messageUuid,
    messageKeyId: env.messageKeyId,
    senderUserUuid: env.senderUserUuid,
    senderDeviceUuid: env.senderDeviceUuid,
    createdAt: env.createdAt,
  });
  let plain: Uint8Array;
  try {
    plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(env.ciphertextBase64Url),
      bodyAad,
      fromBase64Url(env.aead.nonceBase64Url),
      messageKey,
    );
  } catch {
    throw new FscpDecryptError(
      "body_decrypt_failed",
      "AEAD тела группового сообщения не расшифровался (ключ/AAD не совпали).",
    );
  }

  let plaintext: FscpMessagePlaintext;
  try {
    plaintext = normalizeFscpMessagePlaintext(JSON.parse(new TextDecoder().decode(plain)));
  } catch {
    throw new FscpDecryptError("malformed_plaintext", "Расшифрованный plaintext группового сообщения имеет неверную форму.");
  }

  return {
    plaintext,
    conversationUuid: env.conversationUuid,
    messageUuid: env.messageUuid,
    senderUserUuid: env.senderUserUuid,
    createdAt: env.createdAt,
  };
}
