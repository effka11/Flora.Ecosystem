import { getConversationThread } from "@/lib/conversationThreadsCache";
import { decryptFscpWireEnvelope, isFscpWirePayload, type FscpMessagePlaintext } from "@/lib/fscp";
import { preloadMessageMediaFromPlaintexts } from "@/lib/messageMediaCache";
import { parseDemoPlaintextWire } from "@/lib/devLocalDemoData";

const inflight = new Set<string>();

async function decryptThreadPlaintexts(
  viewerNorm: string,
  peerUuid: string,
  viewerUuid: string,
  agreementPrivateKey: Uint8Array,
): Promise<FscpMessagePlaintext[]> {
  const page = await getConversationThread(viewerNorm, peerUuid);
  const plaintexts: FscpMessagePlaintext[] = [];
  for (const message of page.items) {
    const enc = message.encryptedForMe?.trim();
    if (!enc) continue;
    const demoPlain = parseDemoPlaintextWire(enc);
    if (demoPlain) {
      plaintexts.push(demoPlain);
      continue;
    }
    if (!isFscpWirePayload(enc)) continue;
    try {
      const plain = await decryptFscpWireEnvelope({
        wire: enc,
        viewerUserUuid: viewerUuid,
        agreementPrivateKey,
      });
      plaintexts.push(plain);
    } catch {
      /* skip message */
    }
  }
  return plaintexts;
}

/** Фоновая расшифровка треда и предзагрузка фото/видео (без mark read). */
export function preloadConversationThreadMedia(
  viewerNorm: string,
  peerUuid: string,
  viewerUuid: string,
  agreementPrivateKey: Uint8Array,
): void {
  const norm = viewerNorm.trim().toLowerCase();
  const peer = peerUuid.trim().toLowerCase();
  if (!norm || !peer || !viewerUuid.trim()) return;
  const jobKey = `${norm}:${peer}`;
  if (inflight.has(jobKey)) return;
  inflight.add(jobKey);
  void decryptThreadPlaintexts(norm, peer, viewerUuid.trim(), agreementPrivateKey)
    .then((plaintexts) => {
      preloadMessageMediaFromPlaintexts(plaintexts);
    })
    .catch(() => {})
    .finally(() => {
      inflight.delete(jobKey);
    });
}
