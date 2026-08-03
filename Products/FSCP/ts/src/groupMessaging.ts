/**
 * FSCP-G client helpers — fetch member keys, build/decrypt group text wire.
 * HTTP send lives in `@flora/client-core/api/groups` (`apiSendGroupMessage`).
 * Shared by Apps/Web and (later) Apps/Mobile; do not fork into Apps/Web/lib/fscp.
 */

import { fromBase64Url } from "./base64url.js";
import {
  buildFscpGroupWireEnvelope,
  decryptFscpGroupWireEnvelope,
  isFscpGroupWirePayload,
  type FscpGroupDecryptedMessage,
  type FscpGroupRecipientInput,
} from "./group.js";
import type { FscpLocalMaterial } from "./keys.js";
import { messagePlaintextFromBlocks, plaintextToPreview } from "./preview.js";
import { apiGetUserE2ePublicKey, apiTryGetUserE2ePublicKey } from "./messaging.js";

export async function fetchGroupRecipientKeys(
  memberUserUuids: readonly string[],
  senderUserUuid: string,
): Promise<FscpGroupRecipientInput[]> {
  const senderNorm = senderUserUuid.trim().toLowerCase();
  const out: FscpGroupRecipientInput[] = [];
  const seen = new Set<string>();
  for (const raw of memberUserUuids) {
    const norm = raw.trim().toLowerCase();
    if (!norm || norm === senderNorm || seen.has(norm)) continue;
    seen.add(norm);
    const key = await apiGetUserE2ePublicKey(norm);
    out.push({
      userUuid: norm,
      agreementPublicKey: fromBase64Url(key.publicKeyBase64),
    });
  }
  return out;
}

/** Reject members without published E2E keys (create/add gate, client-side). */
export async function filterMembersWithE2eKeys(
  memberUserUuids: readonly string[],
): Promise<{ ok: string[]; missing: string[] }> {
  const ok: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of memberUserUuids) {
    const norm = raw.trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const key = await apiTryGetUserE2ePublicKey(norm);
    if (key?.publicKeyBase64) ok.push(norm);
    else missing.push(norm);
  }
  return { ok, missing };
}

export async function buildGroupTextMessageWire(params: {
  conversationUuid: string;
  senderUserUuid: string;
  material: FscpLocalMaterial;
  /** Active members including sender; sender is filtered out of RKE fan-out inputs. */
  memberUserUuids: readonly string[];
  text: string;
}): Promise<string> {
  const recipients = await fetchGroupRecipientKeys(
    params.memberUserUuids,
    params.senderUserUuid,
  );
  return buildFscpGroupWireEnvelope({
    conversationUuid: params.conversationUuid,
    senderUserUuid: params.senderUserUuid,
    senderAgreementPrivateKey: params.material.agreementPrivateKey,
    senderSigningPrivateKey: params.material.signingPrivateKey,
    recipients,
    messagePayload: messagePlaintextFromBlocks([{ kind: "text", body: params.text }]),
  });
}

export async function decryptGroupMessageWire(params: {
  wire: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
}): Promise<FscpGroupDecryptedMessage> {
  return decryptFscpGroupWireEnvelope(params);
}

export async function decryptGroupMessagePreview(params: {
  encryptedPayload: string | null | undefined;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
}): Promise<string | null> {
  const enc = params.encryptedPayload?.trim();
  if (!enc) return null;
  if (!isFscpGroupWirePayload(enc)) return null;
  try {
    const plain = await decryptFscpGroupWireEnvelope({
      wire: enc,
      viewerUserUuid: params.viewerUserUuid,
      agreementPrivateKey: params.agreementPrivateKey,
    });
    return plaintextToPreview(plain.plaintext);
  } catch {
    return "🔒";
  }
}
