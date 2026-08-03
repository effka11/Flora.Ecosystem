import type { MsgMessageDto } from "@flora/client-core/contracts";
import {
  decryptGroupMessageWire,
  decryptMessageWire,
  isFscpGroupWirePayload,
  isFscpWirePayload,
  type FscpLocalMaterial,
  type FscpMessagePlaintext,
} from "@flora/client-core/fscp";

/** Route DM + group wires through the correct decrypt helper. */
export async function decryptThreadWirePlaintext(params: {
  wire: string;
  viewerUserUuid: string;
  material: FscpLocalMaterial;
}): Promise<FscpMessagePlaintext> {
  const wire = params.wire.trim();
  if (isFscpGroupWirePayload(wire)) {
    const decrypted = await decryptGroupMessageWire({
      wire,
      viewerUserUuid: params.viewerUserUuid,
      agreementPrivateKey: params.material.agreementPrivateKey,
    });
    return decrypted.plaintext;
  }
  if (!isFscpWirePayload(wire)) {
    throw new Error("Неизвестный формат шифрованного сообщения.");
  }
  return decryptMessageWire({
    wire,
    viewerUserUuid: params.viewerUserUuid,
    agreementPrivateKey: params.material.agreementPrivateKey,
  });
}

/** In-memory pending outgoing for open group threads (SSE merge). */
const pendingByGroup = new Map<string, MsgMessageDto>();

export function setGroupPendingOutgoing(conversationUuid: string, row: MsgMessageDto | null): void {
  const key = conversationUuid.trim().toLowerCase();
  if (!key) return;
  if (!row) {
    pendingByGroup.delete(key);
    return;
  }
  pendingByGroup.set(key, row);
}

export function getGroupPendingOutgoing(conversationUuid: string): MsgMessageDto | null {
  return pendingByGroup.get(conversationUuid.trim().toLowerCase()) ?? null;
}

export function mergeGroupPendingIntoMessages(
  conversationUuid: string,
  items: MsgMessageDto[],
): MsgMessageDto[] {
  const pending = getGroupPendingOutgoing(conversationUuid);
  if (!pending) return items;
  if (items.some((m) => m.messageUuid === pending.messageUuid)) return items;
  return [...items, pending];
}
