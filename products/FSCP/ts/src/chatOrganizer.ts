/**
 * FSCP-ORG v1 — зашифрованное состояние организации чатов (`fscporg1:`):
 * папки, архив и mute как приватные данные пользователя.
 *
 * Сервер (модуль flora-chat-organizer) хранит только opaque wire + revision и
 * не видит ни названий папок, ни состава, ни того, какие чаты в архиве.
 * Это заменяет plaintext chat-list overlay (user_chat_folders /
 * user_conversation_flags) FSCP-совместимым хранением.
 *
 * Криптография — те же примитивы FSCP v1:
 * - состояние сериализуется в compact-JSON, паддится до бакетов
 *   (`padPlaintextJsonV1`) и шифруется XChaCha20-Poly1305 случайным 32-байтовым
 *   `stateKey`;
 * - `stateKey` заворачивается self-RKE (x25519-hkdf-xchacha20poly1305) на
 *   собственный agreement public key владельца — тот же материал, что для DM,
 *   доступен всем устройствам через backup/login-handoff;
 * - конверт подписан Ed25519 (`flora.messaging.chat-organizer-signature.v1`);
 * - `revision` входит в AAD: сервер не может подменить ciphertext одной ревизии
 *   ciphertext'ом другой. Полный rollback на старую ревизию клиент ловит
 *   сравнением с локально закэшированной ревизией.
 */

import { FSCP_BOOTSTRAP_DEVICE_UUID, FSCP_BOOTSTRAP_KEY_EPOCH_ID } from "./constants.js";
import { agreementPublicKeyId } from "./deriveIds.js";
import { canonicalJson } from "./canonicalJson.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { rkeUnwrapMessageKey, rkeWrapMessageKey } from "./rke.js";
import { getSodium, scalarmultBase } from "./sodium.js";
import {
  FscpDecryptError,
  padPlaintextJsonV1,
  type FscpRecipientKeyEnvelopeWire,
} from "./envelope.js";

const VARIANT = 7; // sodium base64 URLSAFE_NO_PADDING

/** Префикс wire организатора чатов. */
export const FSCP_ORGANIZER_WIRE_PREFIX = "fscporg1:";

const ORGANIZER_SIGNATURE_DOMAIN = "flora.messaging.chat-organizer-signature.v1";

/** Лимиты plaintext-состояния (клиентская проверка до шифрования). */
export const FSCP_ORGANIZER_MAX_ENTITIES = 64;
export const FSCP_ORGANIZER_LABEL_MAX = 80;

/** AAD тела состояния. */
export function organizerStateAadLine(params: {
  ownerUserUuid: string;
  keyEpochId: string;
  revision: number;
  updatedAt: string;
}): string {
  return [
    "flora.messaging.chat-organizer.v1",
    params.ownerUserUuid.toLowerCase(),
    params.keyEpochId.toLowerCase(),
    String(params.revision),
    params.updatedAt,
  ].join(" | ");
}

/** AAD self-RKE ключа состояния. */
export function organizerKeyEnvelopeAadLine(params: {
  ownerUserUuid: string;
  keyEpochId: string;
  revision: number;
  recipientAgreementPublicKeyId: string;
}): string {
  return [
    "flora.messaging.chat-organizer-key-envelope.v1",
    params.ownerUserUuid.toLowerCase(),
    params.keyEpochId.toLowerCase(),
    String(params.revision),
    params.recipientAgreementPublicKeyId.toLowerCase(),
  ].join(" | ");
}

export type FscpOrganizerEntityKind = "folder" | "group";

/** Пользовательская сущность списка чатов (папка или ярлык группы). */
export type FscpOrganizerEntity = {
  id: string;
  kind: FscpOrganizerEntityKind;
  label: string;
  icon?: string;
  avatarUri?: string | null;
  /** DM-собеседники в папке. */
  memberPeerUuids: string[];
  /** Групповые беседы в папке (conversationUuid). */
  memberConversationUuids: string[];
  createdAtMs: number;
};

/** Plaintext-схема состояния организатора (внутри AEAD, сервер не видит). */
export type FscpOrganizerStatePlaintext = {
  type: "chat-organizer";
  version: 1;
  entities: FscpOrganizerEntity[];
  /** Архив/мьют DM-чатов по peer uuid. */
  archivedByPeer: Record<string, true>;
  mutedByPeer: Record<string, true>;
  /** Архив/мьют групповых бесед по conversation uuid. */
  archivedByConversation: Record<string, true>;
  mutedByConversation: Record<string, true>;
  clientUpdatedAt: string;
};

export function emptyFscpOrganizerState(nowIso?: string): FscpOrganizerStatePlaintext {
  return {
    type: "chat-organizer",
    version: 1,
    entities: [],
    archivedByPeer: {},
    mutedByPeer: {},
    archivedByConversation: {},
    mutedByConversation: {},
    clientUpdatedAt: nowIso ?? new Date().toISOString(),
  };
}

/** Wire-конверт организатора. */
export type FscpOrganizerEnvelopeWire = {
  version: number;
  ownerUserUuid: string;
  keyEpochId: string;
  revision: number;
  updatedAt: string;
  ciphertextBase64Url: string;
  aead: { name: "xchacha20-poly1305"; nonceBase64Url: string };
  keyEnvelope: FscpRecipientKeyEnvelopeWire;
  ownerSigningPublicKeyBase64Url?: string;
  ownerSignatureBase64Url: string;
};

export type FscpOrganizerDecrypted = {
  state: FscpOrganizerStatePlaintext;
  revision: number;
  updatedAt: string;
};

function flagMap(raw: unknown): Record<string, true> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, true> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === true && k.trim()) out[k] = true;
  }
  return out;
}

function uniqueIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Нормализация plaintext-состояния (forward-compat: неизвестные поля игнорируются,
 * неизвестные kind сущностей отбрасываются, `pad` игнорируется как top-level поле).
 */
export function normalizeFscpOrganizerState(raw: unknown): FscpOrganizerStatePlaintext {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!obj || obj.type !== "chat-organizer" || obj.version !== 1) {
    throw new Error("Неверный plaintext состояния организатора.");
  }
  const entities: FscpOrganizerEntity[] = [];
  if (Array.isArray(obj.entities)) {
    for (const item of obj.entities) {
      if (entities.length >= FSCP_ORGANIZER_MAX_ENTITIES) break;
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      if (typeof e.id !== "string" || !e.id.trim()) continue;
      if (e.kind !== "folder" && e.kind !== "group") continue;
      if (typeof e.label !== "string" || !e.label.trim()) continue;
      entities.push({
        id: e.id.trim(),
        kind: e.kind,
        label: e.label.trim().slice(0, FSCP_ORGANIZER_LABEL_MAX),
        icon: typeof e.icon === "string" && e.icon.trim() ? e.icon.trim() : undefined,
        avatarUri:
          typeof e.avatarUri === "string"
            ? e.avatarUri
            : e.avatarUri === null
              ? null
              : undefined,
        memberPeerUuids: uniqueIds(e.memberPeerUuids),
        memberConversationUuids: uniqueIds(e.memberConversationUuids),
        createdAtMs:
          typeof e.createdAtMs === "number" && Number.isFinite(e.createdAtMs)
            ? e.createdAtMs
            : Date.now(),
      });
    }
  }
  return {
    type: "chat-organizer",
    version: 1,
    entities,
    archivedByPeer: flagMap(obj.archivedByPeer),
    mutedByPeer: flagMap(obj.mutedByPeer),
    archivedByConversation: flagMap(obj.archivedByConversation),
    mutedByConversation: flagMap(obj.mutedByConversation),
    clientUpdatedAt:
      typeof obj.clientUpdatedAt === "string" ? obj.clientUpdatedAt : new Date().toISOString(),
  };
}

function envelopeWireForSigning(
  env: FscpOrganizerEnvelopeWire,
): Omit<FscpOrganizerEnvelopeWire, "ownerSignatureBase64Url"> {
  const { ownerSignatureBase64Url: _omit, ...rest } = env;
  return rest;
}

/** Сборка wire состояния организатора (ревизию назначает вызывающий: current + 1). */
export async function buildFscpOrganizerWireEnvelope(params: {
  ownerUserUuid: string;
  ownerAgreementPrivateKey: Uint8Array;
  ownerSigningPrivateKey: Uint8Array;
  revision: number;
  state: FscpOrganizerStatePlaintext;
}): Promise<string> {
  const sodium = await getSodium();
  const ownerNorm = params.ownerUserUuid.trim().toLowerCase();
  if (!ownerNorm) throw new Error("FSCP-ORG: пустой ownerUserUuid.");
  if (!Number.isInteger(params.revision) || params.revision < 1) {
    throw new Error("FSCP-ORG: revision должен быть целым числом ≥ 1.");
  }
  if (params.state.entities.length > FSCP_ORGANIZER_MAX_ENTITIES) {
    throw new Error(`FSCP-ORG: больше ${FSCP_ORGANIZER_MAX_ENTITIES} сущностей не поддерживается.`);
  }

  const keyEpochId = FSCP_BOOTSTRAP_KEY_EPOCH_ID;
  const updatedAt = new Date().toISOString();
  const ownerAgreementPublic = scalarmultBase(sodium, params.ownerAgreementPrivateKey);
  const ownerAgreementId = agreementPublicKeyId(ownerNorm, keyEpochId);

  const stateKey = sodium.randombytes_buf(32);
  const plaintextUtf8 = padPlaintextJsonV1(JSON.stringify(params.state));

  const bodyAad = organizerStateAadLine({
    ownerUserUuid: ownerNorm,
    keyEpochId,
    revision: params.revision,
    updatedAt,
  });
  const bodyNonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const bodyCipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    utf8Bytes(plaintextUtf8),
    bodyAad,
    null,
    bodyNonce,
    stateKey,
  );

  const ephemeralSecret = sodium.randombytes_buf(32);
  const salt32 = sodium.randombytes_buf(32);
  const keyAad = organizerKeyEnvelopeAadLine({
    ownerUserUuid: ownerNorm,
    keyEpochId,
    revision: params.revision,
    recipientAgreementPublicKeyId: ownerAgreementId,
  });
  const wrapped = rkeWrapMessageKey({
    sodium,
    ephemeralSecret,
    recipientAgreementPublicKey: ownerAgreementPublic,
    salt32,
    aadUtf8Line: keyAad,
    messageKey32: stateKey,
  });

  const signSeed = params.ownerSigningPrivateKey.subarray(0, 32);
  const signingPublicKey =
    sodium.crypto_sign_seed_keypair?.(signSeed).publicKey ??
    (params.ownerSigningPrivateKey.byteLength >= 64
      ? params.ownerSigningPrivateKey.subarray(32, 64)
      : undefined);
  if (!signingPublicKey) {
    throw new Error("FSCP-ORG: не удалось вывести публичный ключ подписи.");
  }

  const envelopeNoSig: Omit<FscpOrganizerEnvelopeWire, "ownerSignatureBase64Url"> = {
    version: 1,
    ownerUserUuid: ownerNorm,
    keyEpochId,
    revision: params.revision,
    updatedAt,
    ciphertextBase64Url: sodium.to_base64(bodyCipher, VARIANT),
    aead: { name: "xchacha20-poly1305", nonceBase64Url: sodium.to_base64(bodyNonce, VARIANT) },
    keyEnvelope: {
      version: 1,
      algorithm: "x25519-hkdf-xchacha20poly1305",
      ephemeralPublicKeyBase64Url: sodium.to_base64(wrapped.ephemeralPublicKey, VARIANT),
      recipientAgreementPublicKeyId: ownerAgreementId,
      preKeyId: null,
      saltBase64Url: sodium.to_base64(salt32, VARIANT),
      aead: {
        name: "xchacha20-poly1305",
        nonceBase64Url: sodium.to_base64(wrapped.nonce, VARIANT),
      },
      ciphertextBase64Url: sodium.to_base64(wrapped.ciphertext, VARIANT),
    },
    ownerSigningPublicKeyBase64Url: sodium.to_base64(signingPublicKey, VARIANT),
  };

  const signPayload = utf8Bytes(
    `${ORGANIZER_SIGNATURE_DOMAIN} | ${canonicalJson(envelopeNoSig)}`,
  );
  const sig = sodium.crypto_sign_detached(signPayload, params.ownerSigningPrivateKey);
  const full: FscpOrganizerEnvelopeWire = {
    ...envelopeNoSig,
    ownerSignatureBase64Url: sodium.to_base64(sig, VARIANT),
  };

  return `${FSCP_ORGANIZER_WIRE_PREFIX}${sodium.to_base64(utf8Bytes(JSON.stringify(full)), VARIANT)}`;
}

export function isFscpOrganizerWirePayload(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(FSCP_ORGANIZER_WIRE_PREFIX);
}

/** Открытие wire организатора. Проверяет подпись, владельца и AAD-привязку ревизии. */
export async function decryptFscpOrganizerWireEnvelope(params: {
  wire: string;
  ownerUserUuid: string;
  agreementPrivateKey: Uint8Array;
}): Promise<FscpOrganizerDecrypted> {
  if (!params.wire.startsWith(FSCP_ORGANIZER_WIRE_PREFIX)) {
    throw new FscpDecryptError("not_fscp_wire", "Не FSCP-ORG wire.");
  }
  const sodium = await getSodium();
  let env: FscpOrganizerEnvelopeWire;
  try {
    const raw = fromBase64Url(params.wire.slice(FSCP_ORGANIZER_WIRE_PREFIX.length));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as FscpOrganizerEnvelopeWire).keyEnvelope !== "object"
    ) {
      throw new Error("envelope shape");
    }
    env = parsed as FscpOrganizerEnvelopeWire;
  } catch {
    throw new FscpDecryptError("malformed_envelope", "Повреждённый конверт организатора (base64/JSON/форма).");
  }
  if (env.version !== 1 || !Number.isInteger(env.revision) || env.revision < 1) {
    throw new FscpDecryptError("malformed_envelope", "Неподдерживаемая версия/ревизия конверта организатора.");
  }

  const ownerNorm = params.ownerUserUuid.trim().toLowerCase();
  if (env.ownerUserUuid.trim().toLowerCase() !== ownerNorm) {
    throw new FscpDecryptError("no_recipient_entry", "Конверт организатора принадлежит другому пользователю.");
  }

  {
    const pkB64 = env.ownerSigningPublicKeyBase64Url;
    if (!pkB64 || pkB64.trim().length === 0) {
      throw new FscpDecryptError("signature_missing", "Конверт организатора без подписи отклонён.");
    }
    const signPayload = utf8Bytes(
      `${ORGANIZER_SIGNATURE_DOMAIN} | ${canonicalJson(envelopeWireForSigning(env))}`,
    );
    let ok = false;
    try {
      ok = sodium.crypto_sign_verify_detached(
        fromBase64Url(env.ownerSignatureBase64Url),
        signPayload,
        fromBase64Url(pkB64),
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new FscpDecryptError("signature_invalid", "Подпись конверта организатора не прошла проверку.");
    }
  }

  const keyAad = organizerKeyEnvelopeAadLine({
    ownerUserUuid: env.ownerUserUuid,
    keyEpochId: env.keyEpochId,
    revision: env.revision,
    recipientAgreementPublicKeyId: env.keyEnvelope.recipientAgreementPublicKeyId,
  });
  let stateKey: Uint8Array;
  try {
    stateKey = rkeUnwrapMessageKey({
      sodium,
      agreementPrivateKey: params.agreementPrivateKey,
      ephemeralPublicKey: fromBase64Url(env.keyEnvelope.ephemeralPublicKeyBase64Url),
      salt32: fromBase64Url(env.keyEnvelope.saltBase64Url),
      aadUtf8Line: keyAad,
      nonce: fromBase64Url(env.keyEnvelope.aead.nonceBase64Url),
      ciphertext: fromBase64Url(env.keyEnvelope.ciphertextBase64Url),
    });
  } catch {
    throw new FscpDecryptError("rke_unwrap_failed", "Не удалось развернуть ключ состояния организатора.");
  }

  const bodyAad = organizerStateAadLine({
    ownerUserUuid: env.ownerUserUuid,
    keyEpochId: env.keyEpochId,
    revision: env.revision,
    updatedAt: env.updatedAt,
  });
  let plain: Uint8Array;
  try {
    plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(env.ciphertextBase64Url),
      bodyAad,
      fromBase64Url(env.aead.nonceBase64Url),
      stateKey,
    );
  } catch {
    throw new FscpDecryptError("body_decrypt_failed", "AEAD состояния организатора не расшифровался.");
  }

  let state: FscpOrganizerStatePlaintext;
  try {
    state = normalizeFscpOrganizerState(JSON.parse(new TextDecoder().decode(plain)));
  } catch {
    throw new FscpDecryptError("malformed_plaintext", "Расшифрованное состояние организатора имеет неверную форму.");
  }

  return { state, revision: env.revision, updatedAt: env.updatedAt };
}
