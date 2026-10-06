import type { FscpMessagePlaintext } from "@/lib/fscp";
import type { MsgMessageDto } from "@/lib/messagingApi";
import type { MessageThreadItemDto } from "@/lib/socialApi";
import { peekConversationThreadEntry } from "@/lib/conversationThreadsCache";
import { peekGroupConversationThreadEntry } from "@/lib/groupThreadsCache";
import {
  plaintextThreadKey,
  readMessagePlaintextSeed,
  type PlaintextThreadKind,
} from "@/lib/messagePlaintextSessionCache";

const DECRYPT_FAIL_LABEL = "[ не удалось расшифровать ]";

export type ThreadOpenTarget =
  | { kind: "dm"; peerUuid: string }
  | { kind: "group"; conversationUuid: string };

export type ThreadOpenSnapshot = {
  messages: MessageThreadItemDto[];
  fetchedAt: number | null;
  fetchedForViewerNorm: string | null;
  decryptedById: Record<string, FscpMessagePlaintext>;
  decryptFailById: Record<string, string>;
};

export function toMessageDto(message: MsgMessageDto): MessageThreadItemDto {
  return {
    messageUuid: message.messageUuid,
    content: message.content,
    encryptedForMe: message.encryptedForMe,
    createdAt: message.createdAt,
    isFromMe: message.isFromMe,
    isRead: message.isRead,
    senderUserUuid: message.senderUserUuid,
    serverFrankReceipt: message.serverFrankReceipt ?? null,
    frankTagBase64Url: message.frankTagBase64Url ?? null,
  };
}

export function groupApiMessagesToThread(
  items: readonly {
    messageUuid: string;
    senderUserUuid: string;
    encryptedWire: string;
    createdAt: string;
    isFromMe: boolean;
  }[],
): MessageThreadItemDto[] {
  return items.map((message) => ({
    messageUuid: message.messageUuid,
    content: null,
    encryptedForMe: message.encryptedWire,
    createdAt: message.createdAt,
    isFromMe: message.isFromMe,
    senderUserUuid: message.senderUserUuid,
  }));
}

function emptySnapshot(): ThreadOpenSnapshot {
  return {
    messages: [],
    fetchedAt: null,
    fetchedForViewerNorm: null,
    decryptedById: {},
    decryptFailById: {},
  };
}

function withPlaintext(
  viewerNorm: string,
  kind: PlaintextThreadKind,
  threadId: string,
  messages: MessageThreadItemDto[],
  fetchedAt: number,
): ThreadOpenSnapshot {
  const seed = readMessagePlaintextSeed(plaintextThreadKey(viewerNorm, kind, threadId), messages);
  const decryptFailById: Record<string, string> = {};
  for (const id of seed.failedIds) decryptFailById[id] = DECRYPT_FAIL_LABEL;
  return {
    messages,
    fetchedAt,
    fetchedForViewerNorm: viewerNorm,
    decryptedById: seed.decryptedById,
    decryptFailById,
  };
}

/** First-commit thread state. Reads ciphertext and plaintext caches only — no network. */
export function threadOpenSnapshot(viewerNorm: string, target: ThreadOpenTarget): ThreadOpenSnapshot {
  const viewer = viewerNorm.trim().toLowerCase();
  if (!viewer) return emptySnapshot();
  if (target.kind === "dm") {
    const peer = target.peerUuid.trim();
    if (!peer) return emptySnapshot();
    const cached = peekConversationThreadEntry(viewer, peer);
    if (!cached) return emptySnapshot();
    return withPlaintext(viewer, "dm", peer, cached.value.items.map(toMessageDto), cached.fetchedAt);
  }
  const conversationUuid = target.conversationUuid.trim();
  if (!conversationUuid) return emptySnapshot();
  const cached = peekGroupConversationThreadEntry(viewer, conversationUuid);
  if (!cached) return emptySnapshot();
  return withPlaintext(
    viewer,
    "group",
    conversationUuid,
    groupApiMessagesToThread(cached.value.items),
    cached.fetchedAt,
  );
}
