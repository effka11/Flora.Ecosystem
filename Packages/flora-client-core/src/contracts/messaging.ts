import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type MsgConversationDto = {
  conversationUuid: string;
  otherUserUuid: string;
  otherUsername: string;
  otherDisplayName: string;
  otherAvatarUuid: string | null;
  lastMessageEncryptedForMe: string | null;
  lastMessageContent: string | null;
  lastMessageAt: string;
  lastMessageIsFromMe: boolean;
  unreadCount: number;
  otherUserIsOnline: boolean;
  otherUserLastSeenAt: string | null;
};

export type MsgConversationsPage = {
  items: MsgConversationDto[];
  nextCursor: string | null;
};

export type MsgMessageDto = {
  messageUuid: string;
  conversationUuid: string;
  senderUserUuid: string;
  encryptedPayload: string;
  createdAt: string;
  isFromMe: boolean;
  isRead: boolean;
};

export type MsgMessagesPage = {
  items: MsgMessageDto[];
  nextCursor: string | null;
};

export type MsgSentMessageDto = {
  messageUuid: string;
  createdAt: string;
  encryptedForMe: string;
};

function parseConversation(raw: unknown, ctx?: ParseContext): MsgConversationDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const conversationUuid = readStr(o, ["conversationUuid", "ConversationUuid"], fb);
  if (!conversationUuid) return null;
  return {
    conversationUuid,
    otherUserUuid: readStr(o, ["otherUserUuid", "OtherUserUuid"], fb),
    otherUsername: readStr(o, ["otherUsername", "OtherUsername"], fb),
    otherDisplayName: readStr(o, ["otherDisplayName", "OtherDisplayName"], fb),
    otherAvatarUuid: readStr(o, ["otherAvatarUuid", "OtherAvatarUuid"], fb) || null,
    lastMessageEncryptedForMe:
      readStr(o, ["lastMessageEncryptedForMe", "LastMessageEncryptedForMe"], fb) || null,
    lastMessageContent: readStr(o, ["lastMessageContent", "LastMessageContent"], fb) || null,
    lastMessageAt: readStr(o, ["lastMessageAt", "LastMessageAt"], fb),
    lastMessageIsFromMe: readBool(o, ["lastMessageIsFromMe", "LastMessageIsFromMe"], fb),
    unreadCount: readNum(o, ["unreadCount", "UnreadCount"], fb) ?? 0,
    otherUserIsOnline: readBool(o, ["otherUserIsOnline", "OtherUserIsOnline"], fb),
    otherUserLastSeenAt: readStr(o, ["otherUserLastSeenAt", "OtherUserLastSeenAt"], fb) || null,
  };
}

export function parseConversationsPage(raw: unknown, ctx?: ParseContext): MsgConversationsPage {
  const o = asRecord(raw);
  if (!o) return { items: [], nextCursor: null };
  const fb = ctx?.onPascalFallback;
  const itemsRaw = o.items ?? o.Items;
  const items = Array.isArray(itemsRaw)
    ? itemsRaw.map((x) => parseConversation(x, ctx)).filter((x): x is MsgConversationDto => x !== null)
    : [];
  return {
    items,
    nextCursor: readStr(o, ["nextCursor", "NextCursor"], fb) || null,
  };
}

function parseMessage(raw: unknown, ctx?: ParseContext): MsgMessageDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const messageUuid = readStr(o, ["messageUuid", "MessageUuid"], fb);
  if (!messageUuid) return null;
  const encryptedForMe = readStr(o, ["encryptedForMe", "EncryptedForMe"], fb);
  const encryptedPayload =
    encryptedForMe ||
    readStr(o, ["encryptedPayload", "EncryptedPayload", "content", "Content"], fb);
  return {
    messageUuid,
    conversationUuid: readStr(o, ["conversationUuid", "ConversationUuid"], fb),
    senderUserUuid: readStr(o, ["senderUserUuid", "SenderUserUuid"], fb),
    encryptedPayload,
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    isFromMe: readBool(o, ["isFromMe", "IsFromMe"], fb),
    isRead: readBool(o, ["isRead", "IsRead"], fb),
  };
}

export function parseMessagesPage(raw: unknown, ctx?: ParseContext): MsgMessagesPage {
  const o = asRecord(raw);
  if (!o) return { items: [], nextCursor: null };
  const fb = ctx?.onPascalFallback;
  const itemsRaw = o.items ?? o.Items;
  const items = Array.isArray(itemsRaw)
    ? itemsRaw.map((x) => parseMessage(x, ctx)).filter((x): x is MsgMessageDto => x !== null)
    : [];
  return {
    items,
    nextCursor: readStr(o, ["nextCursor", "NextCursor"], fb) || null,
  };
}

export function parseSentMessage(raw: unknown, ctx?: ParseContext): MsgSentMessageDto {
  const o = asRecord(raw) ?? {};
  const fb = ctx?.onPascalFallback;
  const messageUuid = readStr(o, ["messageUuid", "MessageUuid"], fb);
  if (!messageUuid) throw new Error("Некорректный ответ сервера при отправке сообщения.");
  return {
    messageUuid,
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb) || new Date().toISOString(),
    encryptedForMe: readStr(o, ["encryptedForMe", "EncryptedForMe"], fb),
  };
}
