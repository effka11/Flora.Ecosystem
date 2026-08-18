import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type MsgGroupListItem = {
  conversationUuid: string;
  title: string;
  createdByUserUuid: string;
  createdAt: string;
  memberCount: number;
  lastMessageEncryptedWire: string | null;
  lastMessageAt: string | null;
  lastMessageIsFromMe: boolean;
  /** Display name of last sender when not from me (not username). Empty → client shows «Участник». */
  lastMessageSenderDisplayName: string | null;
  unreadCount: number;
};

export type MsgGroupMember = {
  userUuid: string;
  username: string;
  displayName: string;
  avatarUuid: string | null;
  joinedAt: string;
  /** Present on wire payloads; parsers default missing to false. */
  accountBlocked?: boolean;
};

export type MsgGroupDetail = {
  conversationUuid: string;
  title: string;
  createdByUserUuid: string;
  createdAt: string;
  members: MsgGroupMember[];
};

export type MsgGroupMessage = {
  messageUuid: string;
  senderUserUuid: string;
  encryptedWire: string;
  createdAt: string;
  isFromMe: boolean;
};

export type MsgGroupMessagesPage = {
  items: MsgGroupMessage[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type MsgGroupSendResult = {
  messageUuid: string;
  createdAt: string;
  encryptedWire: string;
};

function parseMember(raw: unknown, ctx?: ParseContext): MsgGroupMember | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const userUuid = readStr(o, ["userUuid", "UserUuid"], fb);
  if (!userUuid) return null;
  return {
    userUuid,
    username: readStr(o, ["username", "Username"], fb),
    displayName: readStr(o, ["displayName", "DisplayName"], fb),
    avatarUuid: readStr(o, ["avatarUuid", "AvatarUuid"], fb) || null,
    joinedAt: readStr(o, ["joinedAt", "JoinedAt"], fb),
    accountBlocked: readBool(o, ["accountBlocked", "AccountBlocked"], fb),
  };
}

function parseListItem(raw: unknown, ctx?: ParseContext): MsgGroupListItem | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const conversationUuid = readStr(o, ["conversationUuid", "ConversationUuid"], fb);
  if (!conversationUuid) return null;
  return {
    conversationUuid,
    title: readStr(o, ["title", "Title"], fb) || "Группа",
    createdByUserUuid: readStr(o, ["createdByUserUuid", "CreatedByUserUuid"], fb),
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    memberCount: readNum(o, ["memberCount", "MemberCount"], fb) ?? 0,
    lastMessageEncryptedWire:
      readStr(o, ["lastMessageEncryptedWire", "LastMessageEncryptedWire"], fb) || null,
    lastMessageAt: readStr(o, ["lastMessageAt", "LastMessageAt"], fb) || null,
    lastMessageIsFromMe: readBool(o, ["lastMessageIsFromMe", "LastMessageIsFromMe"], fb),
    lastMessageSenderDisplayName:
      readStr(o, ["lastMessageSenderDisplayName", "LastMessageSenderDisplayName"], fb) || null,
    unreadCount: readNum(o, ["unreadCount", "UnreadCount"], fb) ?? 0,
  };
}

export function parseGroupsPage(raw: unknown, ctx?: ParseContext): MsgGroupListItem[] {
  const o = asRecord(raw);
  if (!o) return [];
  const itemsRaw = o.items ?? o.Items;
  if (!Array.isArray(itemsRaw)) return [];
  return itemsRaw
    .map((x) => parseListItem(x, ctx))
    .filter((x): x is MsgGroupListItem => x !== null);
}

export function parseGroupDetail(raw: unknown, ctx?: ParseContext): MsgGroupDetail {
  const o = asRecord(raw) ?? {};
  const fb = ctx?.onPascalFallback;
  const conversationUuid = readStr(o, ["conversationUuid", "ConversationUuid"], fb);
  if (!conversationUuid) throw new Error("Некорректный ответ: нет conversationUuid группы.");
  const membersRaw = o.members ?? o.Members;
  const members = Array.isArray(membersRaw)
    ? membersRaw.map((x) => parseMember(x, ctx)).filter((x): x is MsgGroupMember => x !== null)
    : [];
  return {
    conversationUuid,
    title: readStr(o, ["title", "Title"], fb) || "Группа",
    createdByUserUuid: readStr(o, ["createdByUserUuid", "CreatedByUserUuid"], fb),
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    members,
  };
}

export function parseGroupMessagesPage(raw: unknown, ctx?: ParseContext): MsgGroupMessagesPage {
  const o = asRecord(raw);
  if (!o) return { items: [], nextCursor: null, hasMore: false };
  const fb = ctx?.onPascalFallback;
  const itemsRaw = o.items ?? o.Items;
  const items = Array.isArray(itemsRaw)
    ? itemsRaw
        .map((x) => {
          const row = asRecord(x);
          if (!row) return null;
          const messageUuid = readStr(row, ["messageUuid", "MessageUuid"], fb);
          if (!messageUuid) return null;
          return {
            messageUuid,
            senderUserUuid: readStr(row, ["senderUserUuid", "SenderUserUuid"], fb),
            encryptedWire: readStr(row, ["encryptedWire", "EncryptedWire"], fb),
            createdAt: readStr(row, ["createdAt", "CreatedAt"], fb),
            isFromMe: readBool(row, ["isFromMe", "IsFromMe"], fb),
          } satisfies MsgGroupMessage;
        })
        .filter((x): x is MsgGroupMessage => x !== null)
    : [];
  return {
    items,
    nextCursor: readStr(o, ["nextCursor", "NextCursor"], fb) || null,
    hasMore: readBool(o, ["hasMore", "HasMore"], fb),
  };
}

export function parseGroupSendResult(raw: unknown, ctx?: ParseContext): MsgGroupSendResult {
  const o = asRecord(raw) ?? {};
  const fb = ctx?.onPascalFallback;
  const messageUuid = readStr(o, ["messageUuid", "MessageUuid"], fb);
  if (!messageUuid) throw new Error("Некорректный ответ сервера при отправке в группу.");
  return {
    messageUuid,
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb) || new Date().toISOString(),
    encryptedWire: readStr(o, ["encryptedWire", "EncryptedWire"], fb),
  };
}
