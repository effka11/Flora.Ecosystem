"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { fscpStatusNeedsPassword, useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { profileDisplayName } from "@/app/_dashboard/userDisplay";
import { useFloraPageTitleOverride } from "@/app/_shared/useFloraDocumentTitle";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { PostMoreMenuRect } from "@/app/_shared/PostMoreMenuRect";
import postMoreMenuStyles from "@/app/_shared/PostMoreMenu.module.css";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import { TabSearchInput } from "@/app/_shared/TabSearchInput";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { ApiRequestError, isDevLocalOfflineSession } from "@/lib/auth";
import { apiGetPushPreviewTargets } from "@flora/client-core/api";
import {
  buildNotificationPreviewBundle,
  type NotificationPreviewKind,
} from "@flora/client-core/fscp";
import { fromBase64Flexible } from "@/lib/fscp/base64url";
import { FSCP_WIRE_PREFIX } from "@/lib/fscp/constants";
import { dmConversationUuid } from "@/lib/fscp/deriveIds";
import {
  buildFscpWireEnvelope,
  decryptFscpWireEnvelope,
  isFscpWirePayload,
  type FscpImageBlock,
  type FscpVideoBlock,
  type FscpMessageBlock,
  type FscpMessagePlaintext,
} from "@/lib/fscp";
import {
  apiGetUserE2ePublicKey,
  apiUploadGroupImageAsset,
  apiUploadGroupVoiceAsset,
  apiUploadMessageImageAsset,
  apiUploadMessageVideoAsset,
  apiUploadMessageVoiceAsset,
  type ConversationListItemDto,
  type MessageThreadItemDto,
} from "@/lib/socialApi";
import {
  extractPastedMessageImages,
  MAX_MESSAGE_IMAGE_BYTES,
  messageImageAttachError,
} from "@/lib/messageImages";
import { encodeImageBlobToFrc } from "@/lib/frcImageSource";
import {
  markMessageImageSendFinished,
  markMessageImageSendStarted,
  scheduleMessageImagePrepare,
} from "@/lib/messageImageSendPrepare";
import {
  markMessageVideoSendFinished,
  markMessageVideoSendStarted,
  scheduleMessageVideoPrepare,
} from "@/lib/messageVideoSendPrepare";
import { messageVideoAttachError, triggerVideoBlobDownload } from "@/lib/messageVideos";
import { conversationsCache } from "@/lib/dashboardPreload";
import {
  getConversationThread,
  invalidateConversationThread,
  peekConversationThread,
} from "@/lib/conversationThreadsCache";
import { floraNewUuid } from "@/lib/floraUuid";
import {
  msgMarkReadForUser,
  MESSAGES_UNREAD_CHANGED_EVENT,
  notifyMessagesUnreadChanged,
  type MessagesChangedDetail,
  msgSendMessageToUser,
  msgDeleteMessageForUser,
  msgDeleteConversationForUser,
  type MsgConversationDto,
  type MsgConversationsPage,
  type MsgMessageDto,
} from "@/lib/messagingApi";
import {
  devDemoAppendOutgoingMessage,
  devGetImageBlob,
  devGetVideoBlob,
  devGetVoiceBlob,
  devPlaintextWire,
  devRegisterImageBlob,
  devRegisterVideoBlob,
  devRegisterVoiceBlob,
  isDemoPlaintextWire,
  parseDemoPlaintextWire,
  devDemoGetThread,
  devDemoDeleteConversation,
} from "@/lib/devLocalDemoData";
import { formatWasOnlineRu } from "@/lib/lastSeenRu";
import {
  READ_CHANGED_EVENT,
  TYPING_CHANGED_EVENT,
  type ReadChangedDetail,
  type TypingChangedDetail,
} from "@/lib/realtimeEvents";
import {
  apiPostTyping,
  apiPresenceHeartbeat,
  createTypingEmitter,
  PRESENCE_TYPING_PEER_TTL_MS,
  sharedPresenceStore,
  type TypingEmitter,
} from "@flora/client-core/presence";
import { ImageMessageCard } from "./ImageMessageCard";
import { MessageImageCollage } from "./MessageImageCollage";
import { MessageBubbleAnchor } from "./MessageBubbleMoreMenu";
import { MessagesDeleteConversationModal } from "./MessagesDeleteConversationModal";
import { MessagesSafetyNumberModal } from "./MessagesSafetyNumberModal";
import { MessageBubbleReplyQuote } from "./MessageBubbleReplyQuote";
import { MessageBubbleText } from "./MessageBubbleText";
import { MessageComposeReplyBar } from "./MessageComposeReplyBar";
import { VideoMessageCard } from "./VideoMessageCard";
import { VoiceMessageCard } from "./VoiceMessageCard";
import styles from "./messages.module.css";
import {
  getVoiceBlockFromPayload,
  isVoiceOnlyPayload,
  messagePlaintextFromText,
  plaintextFromBlocks,
  collapsePhotoPreviewLabels,
  plaintextToPreview,
} from "./messageBlocks";
import { attachReplyToPayload, replyDraftFromMessage, type MessageReplyDraft } from "./messageReply";
import { MusicTrackKindIcon } from "@/app/(dashboard)/music/MusicTrackKindIcon";
import { useMessageComposeDraft } from "./useMessageComposeDraft";
import { useVoiceRecorder } from "./useVoiceRecorder";
import { buildInlineComposeWaveform } from "./voiceWaveform";
import {
  CHAT_INSERT_LIFT_MS,
  estimateMessageInsertLiftPx,
  measureTrailingBubblesInsertLiftPx,
  playChatListInsertLift,
  queryTrailingPeerAvatar,
  resetChatListInsertLift,
} from "./chatListInsertLift";
import {
  MESSAGES_NEAR_BOTTOM_PX,
  MESSAGES_OPEN_REVEAL_DEADLINE_MS,
  MESSAGES_REPIN_WINDOW_MS,
  isMessagesNearBottom,
  noteOptimisticUuidReplace,
  pinMessagesScrollToBottom,
} from "./messagesThreadScroll";
import {
  buildThreadRenderItems,
  shouldHoldTrailingPeerAvatar,
} from "./threadMessageGroups";

function pushPreviewKind(blocks: FscpMessageBlock[]): NotificationPreviewKind {
  const kinds = new Set(blocks.map((block) => (block.kind === "image" ? "photo" : block.kind)));
  if (kinds.size !== 1) return "mixed";
  const only = [...kinds][0];
  return only === "text" || only === "photo" || only === "voice" || only === "video"
    ? only
    : "mixed";
}

async function buildWebEncryptedPushPreviews(params: {
  wire: string;
  recipientUserUuid: string;
  signingPrivateKey: Uint8Array;
  plaintext: FscpMessagePlaintext;
}) {
  const targets = await apiGetPushPreviewTargets(params.recipientUserUuid).catch(() => []);
  if (targets.length === 0) return [];
  return buildNotificationPreviewBundle({
    messageWire: params.wire,
    recipientUserUuid: params.recipientUserUuid,
    senderSigningPrivateKey: params.signingPrivateKey,
    preview: plaintextToPreview(params.plaintext),
    kind: pushPreviewKind(params.plaintext.blocks),
    targets,
  }).catch(() => []);
}
import { encryptVoiceBlob } from "./voiceCrypto";
import { VOICE_MAX_DURATION_MS, VOICE_MAX_UPLOAD_BYTES } from "./voiceCapture";
import {
  clearPendingVoiceBlob,
  getPendingVoiceBlob,
  registerPendingVoiceBlob,
} from "./pendingVoiceOutgoing";
import { VOICE_HE_AAC_CONTENT_TYPE } from "@/lib/voiceTranscode";
import {
  markVoiceSendFinished,
  markVoiceSendStarted,
  prefetchVoiceTranscodeEngine,
  scheduleVoiceTranscode,
  awaitPreparedVoiceWithFallback,
} from "@/lib/voiceSendPrepare";
import { preloadMessageEmojiPicker } from "./MessageEmojiPicker";
import { MessageComposeAttachMenu, type ComposeAttachKind } from "./MessageComposeAttachMenu";
import {
  MessageStickerPanel,
  MessageStickerPanelAnchor,
  type StickerPanelTab,
  type StickerTabTransition,
} from "./MessageStickerPanel";
import {
  CONVERSATION_MUTE_DEFAULT_DURATION_MS,
  isConversationMuteActive,
  type ConversationMuteEntry,
} from "./conversationMute";
import { MessagesConversationMuteIndicator } from "./MessagesConversationMuteIndicator";
import { CreateChatFolderDialog } from "./CreateChatFolderDialog";
import { CreateGroupDialog } from "./CreateGroupDialog";
import { GroupMembersPanel } from "./GroupMembersPanel";
import {
  formatGroupMembersLabel,
  type GroupChat,
  type GroupMember,
  type MessagesListItem,
  type SelectedTarget,
} from "./groupConversationTypes";
import {
  findGroupMember,
  mapGroupListItem,
  mergeGroupDetail,
  mergeGroupListRefresh,
} from "./groupApiMap";
import {
  apiCreateGroup,
  apiGetGroup,
  apiLeaveGroup,
  apiListGroups,
  apiMarkGroupRead,
  apiAddGroupMember,
  apiPatchGroupTitle,
  apiRemoveGroupMember,
  apiSendGroupMessage,
} from "@flora/client-core/api";
import {
  buildGroupBlocksMessageWire,
  buildGroupTextMessageWire,
  decryptGroupMessagePreview,
  decryptGroupMessageWire,
  filterMembersWithE2eKeys,
  isFscpGroupWirePayload,
} from "@flora/client-core/fscp";
import {
  getGroupConversationThread,
  invalidateGroupConversationThread,
} from "@/lib/groupThreadsCache";
import { MessagesChatFolders } from "./MessagesChatFolders";
import { useMessagesListPreviewDecrypt } from "./useMessagesListPreviewDecrypt";
import { usePreloadConversationThreads } from "./usePreloadConversationThreads";
import { usePreloadThreadMessageMedia } from "./usePreloadThreadMessageMedia";
import { floraDurationMs } from "@/lib/floraMotion";
import {
  addPeerToChatListFolder,
  createChatListFolder,
  refreshChatListOverlay,
  removeChatListFolder,
  setChatListArchived,
  setChatListGroupArchived,
  setChatListKnownGroupUuids,
  setChatListMuted,
  setChatListOverlayFscpKeys,
  useChatListOverlayHydrate,
  useChatListOverlayState,
} from "@/lib/chatListOverlayStore";
import {
  canArchiveChatListPeer,
  canCreateChatListFolder,
  CHAT_LIST_ARCHIVE_FOLDER_ID,
  countArchivedForFolderIcon,
  dmConversationUuidsOfArchivedPeers,
  entitiesToFolderDefs,
  filterConversationsByFolder,
  filterGroupsByFolder,
  isConversationArchived,
  listVisibleChatFolders,
  membershipByEntityId,
  normalizeChatListFolder,
  type ChatListFolderId,
} from "@flora/client-core/messaging";

/** Converts MsgConversationDto (new /api/messaging) to the legacy ConversationListItemDto shape. */
function toConversationDto(c: MsgConversationDto): ConversationListItemDto {
  return {
    otherUserUuid: c.otherUserUuid,
    otherUsername: c.otherUsername,
    otherDisplayName: c.otherDisplayName,
    lastMessageUuid: "",
    lastMessageContent: c.lastMessageContent,
    lastMessageEncryptedForMe: c.lastMessageEncryptedForMe,
    lastMessageIsFromMe: c.lastMessageIsFromMe,
    hasEncryptedPreview:
      !!c.lastMessageEncryptedForMe && !c.lastMessageContent,
    lastMessageAt: c.lastMessageAt,
    unreadCount: c.unreadCount,
    otherUserIsOnline: c.otherUserIsOnline,
    otherUserLastSeenAt: c.otherUserLastSeenAt,
  };
}

type OutgoingListPatch = {
  peerUuid: string;
  /** Тот же шифротекст, который уйдёт в seedListPreview. */
  encryptedForMe: string;
  createdAt: string;
};

/**
 * Оптимистичный патч строки списка после своей отправки: свежий шифротекст наверх.
 * Собеседника нет в списке (новый диалог) — вход возвращается как есть, его подхватит фоновый refresh.
 */
function patchConversationListForOutgoing(
  list: ConversationListItemDto[],
  patch: OutgoingListPatch,
): ConversationListItemDto[] {
  const existing = list.find((c) => c.otherUserUuid === patch.peerUuid);
  if (!existing) return list;
  const updated: ConversationListItemDto = {
    ...existing,
    lastMessageUuid: "",
    lastMessageContent: null,
    lastMessageEncryptedForMe: patch.encryptedForMe,
    lastMessageIsFromMe: true,
    hasEncryptedPreview: true,
    lastMessageAt: patch.createdAt,
  };
  return [updated, ...list.filter((c) => c.otherUserUuid !== patch.peerUuid)];
}

/** Тот же патч для кэшированной страницы `/api/messaging` (порядок = last_message_at DESC). */
function patchConversationsPageForOutgoing(
  page: MsgConversationsPage,
  patch: OutgoingListPatch,
): MsgConversationsPage {
  const existing = page.items.find((c) => c.otherUserUuid === patch.peerUuid);
  if (!existing) return page;
  const updated: MsgConversationDto = {
    ...existing,
    lastMessageContent: null,
    lastMessageEncryptedForMe: patch.encryptedForMe,
    lastMessageIsFromMe: true,
    lastMessageAt: patch.createdAt,
  };
  return {
    ...page,
    items: [updated, ...page.items.filter((c) => c.otherUserUuid !== patch.peerUuid)],
  };
}

/** Converts MsgMessageDto (new /api/messaging) to the legacy MessageThreadItemDto shape. */
function toMessageDto(m: MsgMessageDto): MessageThreadItemDto {
  return {
    messageUuid: m.messageUuid,
    content: m.content,
    encryptedForMe: m.encryptedForMe,
    createdAt: m.createdAt,
    isFromMe: m.isFromMe,
    isRead: m.isRead,
  };
}

function groupApiMessagesToThread(
  items: readonly {
    messageUuid: string;
    senderUserUuid: string;
    encryptedWire: string;
    createdAt: string;
    isFromMe: boolean;
  }[],
): MessageThreadItemDto[] {
  return items.map((m) => ({
    messageUuid: m.messageUuid,
    content: null,
    encryptedForMe: m.encryptedWire,
    createdAt: m.createdAt,
    isFromMe: m.isFromMe,
    senderUserUuid: m.senderUserUuid,
  }));
}

/** Текст пузыря при любой ошибке расшифровки FSCP (в т.ч. сообщения libsodium на англ.). */
const FSCP_DECRYPT_FAIL_LABEL = "[ не удалось расшифровать ]";

const LIST_PREVIEW_MAX_LEN = 80;

/** Синхронно с `--flora-duration-6` в messages.module.css (как MUSIC_TAB_TRANSITION_CLEAR_MS). */
const MESSAGES_PANEL_TRANSITION_CLEAR_MS = 950;
const COMPOSE_TEXT_LINE_HEIGHT_PX = 25;
const COMPOSE_TEXT_VERTICAL_PADDING_PX = 10;
const COMPOSE_MAX_EXTRA_ROWS = 3;
/** Синхронно с `messagesStickerPanelOut` (`--flora-duration-2`). */
const STICKER_PANEL_CLOSE_MS = floraDurationMs(2) + 50;

/** Синхронно с переключением вкладок / layout панели (`--flora-duration-2`). */
const STICKER_TAB_TRANSITION_MS = floraDurationMs(2);
const DELETE_CONVERSATION_MODAL_CLOSE_MS = floraDurationMs(2);

/** Дребезг обновления списка диалогов при серии `MESSAGES_UNREAD_CHANGED_EVENT` подряд. */
const CONVERSATION_LIST_REFRESH_DEBOUNCE_MS = 250;

type MessagesPanelTransition = null | "fromLeft" | "fromRight" | "fromTop" | "fromBottom";

function messagesChatOpenAnimClassName(
  transition: MessagesPanelTransition,
  classNames: {
    fromRight: string;
    fromBottom: string;
    fromTop: string;
  },
): string {
  if (transition === "fromRight") return classNames.fromRight;
  if (transition === "fromBottom") return classNames.fromBottom;
  if (transition === "fromTop") return classNames.fromTop;
  return "";
}

function formatVoiceComposeDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// function formatRailUnreadCount(n: number): string {
//   if (n <= 0) return "";
//   if (n > 99) return "99+";
//   return String(n);
// }

function truncateListPreviewBody(text: string): string {
  const t = text.trim();
  if (!t) return "";
  return t.length > LIST_PREVIEW_MAX_LEN ? t.slice(0, LIST_PREVIEW_MAX_LEN) + "…" : t;
}

/** Превью строки в списке диалогов: серверный plaintext, клиентская расшифровка FSCP или заглушки. */
function conversationPreview(
  c: ConversationListItemDto,
  listPreviewDecryptedByPeer: Record<string, FscpMessagePlaintext>,
  listPreviewDecryptFailByPeer: Record<string, boolean>
): string {
  const fromMe = c.lastMessageIsFromMe;
  const format = (plain: string) => {
    const body = truncateListPreviewBody(collapsePhotoPreviewLabels(plain));
    if (!body) return "Нет сообщений";
    return fromMe ? `Вы: ${body}` : body;
  };

  if (c.lastMessageContent?.trim()) return format(c.lastMessageContent);

  const dec = listPreviewDecryptedByPeer[c.otherUserUuid];
  if (dec) return format(plaintextToPreview(dec));

  if (listPreviewDecryptFailByPeer[c.otherUserUuid]) return FSCP_DECRYPT_FAIL_LABEL;

  const enc = c.lastMessageEncryptedForMe?.trim();
  if (enc && isFscpWirePayload(enc)) return "Расшифровка…";

  if (c.hasEncryptedPreview || enc) {
    return "Зашифрованное сообщение (нужен клиент с ключом E2E)";
  }
  return "Нет сообщений";
}

function formatChatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "…";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

type MessageDeliveryState = "sending" | "sent" | "read";

const MESSAGE_RECEIPT_INLINE_RESERVE_PX = 28;

function messageDeliveryState(message: MessageThreadItemDto): MessageDeliveryState | null {
  if (!message.isFromMe) return null;
  if (message.sendStatus === "sending") return "sending";
  return message.isRead ? "read" : "sent";
}

function MessageReadReceipt({ state }: { state: MessageDeliveryState }) {
  const label =
    state === "sending" ? "Отправляется" : state === "read" ? "Прочитано" : "Отправлено";

  return (
    <span
      className={`${styles.messagesBubbleReceipt} ${
        state === "sending"
          ? styles.messagesBubbleReceiptSending
          : state === "read"
            ? styles.messagesBubbleReceiptRead
            : styles.messagesBubbleReceiptSent
      }`}
      title={label}
      aria-label={label}
    >
      {state === "sending" ? (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 4.8V8l2.2 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : state === "read" ? (
        <>
          <svg viewBox="0 0 16 12" fill="none" aria-hidden>
            <path d="M1.7 6.2 5.3 9.8 14.2 1.8" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <svg viewBox="0 0 16 12" fill="none" aria-hidden>
            <path d="M1.7 6.2 5.3 9.8 14.2 1.8" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </>
      ) : (
        <svg viewBox="0 0 16 12" fill="none" aria-hidden>
          <path d="M1.7 6.2 5.3 9.8 14.2 1.8" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function MessageBubbleTime({
  message,
  className,
}: {
  message: MessageThreadItemDto;
  className?: string;
}) {
  const deliveryState = messageDeliveryState(message);

  return (
    <span className={className ? `${styles.messagesBubbleTime} ${className}` : styles.messagesBubbleTime}>
      {formatChatTime(message.createdAt)}
      {deliveryState ? <MessageReadReceipt state={deliveryState} /> : null}
    </span>
  );
}

function avatarLetters(name: string): string {
  const t = name.trim();
  if (t.length === 0) return "?";
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return t.slice(0, 2).toUpperCase();
}

function isWellFormedUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

/** Пока серверный GET отстаёт, не терять только что отправленное сообщение из ленты. */
function mergePendingOutgoing(
  rows: MessageThreadItemDto[],
  pending: MessageThreadItemDto
): MessageThreadItemDto[] {
  if (rows.some((r) => r.messageUuid === pending.messageUuid)) return rows;
  return [...rows, pending];
}

function replaceOptimisticOutgoing(
  rows: MessageThreadItemDto[],
  optimisticMessageUuid: string,
  real: MessageThreadItemDto
): MessageThreadItemDto[] {
  const idx = rows.findIndex((r) => r.messageUuid === optimisticMessageUuid);
  if (idx === -1) return mergePendingOutgoing(rows, real);
  const next = rows.slice();
  next[idx] = real;
  return next;
}

function localVoiceBlobForAsset(assetUuid: string): Blob | undefined {
  return getPendingVoiceBlob(assetUuid) ?? devGetVoiceBlob(assetUuid);
}

function MessagesChatInner() {
  const { isClient, hasToken } = useProtectedPage();
  const { me, fscpMaterial, fscpBootstrapLoading, fscpBootstrapError, fscpStatus, fscpFailure, openFscpUnlock } =
    useCurrentUser();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationListItemDto[]>(() => {
    const cached = conversationsCache.peek();
    return cached ? cached.items.map(toConversationDto) : [];
  });
  const [listLoading, setListLoading] = useState(() => conversationsCache.peek() === null);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget | null>(null);
  const selectedOtherUuid = selectedTarget?.kind === "dm" ? selectedTarget.otherUserUuid : null;
  const selectedGroupUuid =
    selectedTarget?.kind === "groupChat" ? selectedTarget.conversationUuid : null;
  /** Снимок строки списка при открытии чата (заголовок не пропадает, если список ещё перезагружается). */
  const [selectedPeer, setSelectedPeer] = useState<ConversationListItemDto | null>(null);
  const [groupChats, setGroupChats] = useState<GroupChat[]>([]);
  const [threadMessages, setThreadMessages] = useState<MessageThreadItemDto[]>([]);
  /** Нормализованный me.userUuid на момент последней успешной загрузки ленты; без этого не расшифровываем (иначе кэш чужой ленты + новый JWT). */
  const [threadFetchedForViewerNorm, setThreadFetchedForViewerNorm] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /* Идёт клиентское сжатие прикрепляемого видео (большие файлы перекодируются в реальном времени). */

  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "unread">("recent");
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<
    | { kind: "dm"; peerUuid: string; displayName: string }
    | { kind: "group"; conversationUuid: string; displayName: string }
    | null
  >(null);
  const [deleteConversationModalClosing, setDeleteConversationModalClosing] = useState(false);
  const [deleteConversationBusy, setDeleteConversationBusy] = useState(false);
  const [deleteConversationError, setDeleteConversationError] = useState<string | null>(null);
  const [listFolder, setListFolder] = useState<ChatListFolderId>("all");
  const [filterFrom, setFilterFrom] = useState<"all" | "people" | "communities" | "dev">("all");
  const [dropdownSortOpen, setDropdownSortOpen] = useState(false);
  const [dropdownFilterOpen, setDropdownFilterOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [groupMembersOpen, setGroupMembersOpen] = useState(false);
  const [groupMembersBusy, setGroupMembersBusy] = useState(false);
  const [groupMembersError, setGroupMembersError] = useState<string | null>(null);
  /** Локальный until-мут (UI countdown); forever/sync — overlay.mutedByPeer. */
  const [mutedPeers, setMutedPeers] = useState<Record<string, ConversationMuteEntry>>({});
  const overlayState = useChatListOverlayState();
  const hydrateOverlay = useChatListOverlayHydrate();
  const archivedByPeer = overlayState.archivedByPeer;
  const archivedByConversation = overlayState.archivedByConversation ?? {};
  const mutedByPeer = overlayState.mutedByPeer;
  const compose = useMessageComposeDraft();
  const [decryptedById, setDecryptedById] = useState<Record<string, FscpMessagePlaintext>>({});
  const [decryptFailById, setDecryptFailById] = useState<Record<string, string>>({});
  const decryptingRef = useRef<Set<string>>(new Set());
  const conversationsRef = useRef<ConversationListItemDto[]>([]);
  /** Пока идёт POST+GET после отправки — подмешиваем в ответ листинга, если messageUuid ещё нет. */
  const pendingOutgoingRef = useRef<MessageThreadItemDto | null>(null);
  const threadFetchContextRef = useRef<{ peer: string | null; viewerNorm: string }>({ peer: null, viewerNorm: "" });
  const scrollMessagesRef = useRef<HTMLDivElement | null>(null);
  const messagesInnerRef = useRef<HTMLDivElement | null>(null);
  const messagesChatViewRef = useRef<HTMLDivElement | null>(null);
  /** После успешной загрузки ленты — отслеживаем дифф для новых сообщений собеседника. */
  const scrollTrackingReadyRef = useRef(false);
  const prevSeenMessageIdsRef = useRef<Set<string>>(new Set());
  /** Первый optimistic append — insertLift; ACK replace не ставит флаг. */
  const pendingInsertLiftRef = useRef(false);
  const atBottomRef = useRef(true);
  const openRepinUntilRef = useRef(0);
  /** Пока идёт insertLift — не трогать scrollTop из ResizeObserver (иначе дергание). */
  const liftActiveUntilRef = useRef(0);
  const [openRevealDeadlineElapsed, setOpenRevealDeadlineElapsed] = useState(false);
  const selectedOtherUuidRef = useRef<string | null>(null);
  selectedOtherUuidRef.current = selectedOtherUuid;
  const [peerBelowScrollCount, setPeerBelowScrollCount] = useState(0);
  /** Следующее выравнивание скролла рейла (центр / края) — только после открытия из основного списка или из URL, не при переключении в мини-списке. */
  // const alignRailScrollFromMainListRef = useRef(false);

  const [panelAnimEpoch, setPanelAnimEpoch] = useState(0);
  const [panelTransition, setPanelTransition] = useState<MessagesPanelTransition>(null);
  const panelTransitionClearRef = useRef<number | null>(null);
  const voiceRecorder = useVoiceRecorder(compose.setVoiceFromRecording);
  const composeInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composeSurfaceRef = useRef<HTMLDivElement | null>(null);
  const sendVoiceAfterRecordingRef = useRef(false);
  const [composeExtraRows, setComposeExtraRows] = useState(0);
  const [stickerPanelOpen, setStickerPanelOpen] = useState(false);
  const [stickerPanelRendered, setStickerPanelRendered] = useState(false);
  const [stickerPanelClosing, setStickerPanelClosing] = useState(false);
  const [stickerPanelTab, setStickerPanelTab] = useState<StickerPanelTab>("emoji");
  const [stickerTabTransition, setStickerTabTransition] = useState<StickerTabTransition>(null);
  const [stickerTabAnimEpoch, setStickerTabAnimEpoch] = useState(0);
  const stickerTabTransitionClearRef = useRef<number | null>(null);
  const [composeAttachMenuCloseNonce, setComposeAttachMenuCloseNonce] = useState(0);
  const [composeAttachMenuOpen, setComposeAttachMenuOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<MessageReplyDraft | null>(null);

  const requestCloseStickerPanel = useCallback(() => {
    if (!stickerPanelRendered || stickerPanelClosing) return;
    if (stickerTabTransitionClearRef.current !== null) {
      window.clearTimeout(stickerTabTransitionClearRef.current);
      stickerTabTransitionClearRef.current = null;
    }
    setStickerTabTransition(null);
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStickerPanelOpen(false);
      setStickerPanelRendered(false);
      setStickerPanelClosing(false);
      return;
    }
    setStickerPanelClosing(true);
    setStickerPanelOpen(false);
  }, [stickerPanelRendered, stickerPanelClosing]);

  const selectStickerPanelTab = useCallback(
    (tab: StickerPanelTab) => {
      if (tab === stickerPanelTab || stickerPanelClosing) return;

      if (stickerTabTransitionClearRef.current !== null) {
        window.clearTimeout(stickerTabTransitionClearRef.current);
        stickerTabTransitionClearRef.current = null;
      }

      const reduced =
        typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!reduced) {
        setStickerTabTransition(tab === "emoji" ? "toEmoji" : "toStickers");
        setStickerTabAnimEpoch((epoch) => epoch + 1);
        stickerTabTransitionClearRef.current = window.setTimeout(() => {
          setStickerTabTransition(null);
          stickerTabTransitionClearRef.current = null;
        }, STICKER_TAB_TRANSITION_MS);
      }

      setStickerPanelTab(tab);
    },
    [stickerPanelClosing, stickerPanelTab],
  );

  const requestCloseComposeAttachMenu = useCallback(() => {
    setComposeAttachMenuCloseNonce((nonce) => nonce + 1);
  }, []);

  const toggleStickerPanel = useCallback(() => {
    if (stickerPanelClosing) return;
    if (stickerPanelRendered) {
      requestCloseStickerPanel();
      return;
    }
    requestCloseComposeAttachMenu();
    setStickerPanelRendered(true);
    setStickerPanelOpen(true);
    setStickerPanelClosing(false);
  }, [
    stickerPanelClosing,
    stickerPanelRendered,
    requestCloseStickerPanel,
    requestCloseComposeAttachMenu,
  ]);

  useEffect(() => {
    if (!stickerPanelClosing) return;
    const timeoutId = window.setTimeout(() => {
      setStickerPanelRendered(false);
      setStickerPanelClosing(false);
    }, STICKER_PANEL_CLOSE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [stickerPanelClosing]);

  useEffect(() => {
    if (!stickerPanelRendered || stickerPanelClosing) return;

    const handlePointerDown = (event: PointerEvent) => {
      const surface = composeSurfaceRef.current;
      if (surface && event.target instanceof Node && surface.contains(event.target)) return;
      requestCloseStickerPanel();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      requestCloseStickerPanel();
      composeInputRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [stickerPanelRendered, stickerPanelClosing, requestCloseStickerPanel]);

  useLayoutEffect(() => {
    if (compose.mode !== "text") {
      setComposeExtraRows(0);
      return;
    }

    const input = composeInputRef.current;
    if (!input) return;

    const computed = window.getComputedStyle(input);
    const measure = document.createElement("textarea");
    measure.value = input.value || input.placeholder;
    measure.setAttribute("aria-hidden", "true");
    measure.style.position = "fixed";
    measure.style.left = "-9999px";
    measure.style.top = "0";
    measure.style.width = `${input.clientWidth}px`;
    measure.style.minHeight = "0";
    measure.style.height = "0";
    measure.style.padding = computed.padding;
    measure.style.border = computed.border;
    measure.style.boxSizing = computed.boxSizing;
    measure.style.font = computed.font;
    measure.style.letterSpacing = computed.letterSpacing;
    measure.style.lineHeight = computed.lineHeight;
    measure.style.whiteSpace = "pre-wrap";
    measure.style.wordBreak = "break-word";
    measure.style.overflow = "hidden";
    document.body.appendChild(measure);
    const visibleRows = Math.max(
      1,
      Math.ceil((measure.scrollHeight - COMPOSE_TEXT_VERTICAL_PADDING_PX) / COMPOSE_TEXT_LINE_HEIGHT_PX)
    );
    measure.remove();

    setComposeExtraRows(Math.min(COMPOSE_MAX_EXTRA_ROWS, Math.max(0, visibleRows - 1)));
  }, [compose.mode, compose.text]);

  const composeExtraHeight = composeExtraRows * COMPOSE_TEXT_LINE_HEIGHT_PX;
  /* Каждая полоса над textarea (ответ / медиа): 15px + 60px + 10px gap = 85px. */
  const composeStripCount =
    compose.mode === "text"
      ? (replyTo ? 1 : 0) +
        (compose.images.length > 0 || compose.videos.length > 0 ? 1 : 0)
      : 0;
  const composeImagesExtraHeight = composeStripCount * 85;
  const messagesChatViewStyle = useMemo(
    () =>
      ({
        "--messages-compose-extra-height": `${composeExtraHeight}px`,
        "--messages-compose-images-extra": `${composeImagesExtraHeight}px`,
      }) as CSSProperties,
    [composeExtraHeight, composeImagesExtraHeight]
  );

  conversationsRef.current = conversations;

  const applyPanelTransition = useCallback((transition: MessagesPanelTransition) => {
    if (panelTransitionClearRef.current !== null) {
      window.clearTimeout(panelTransitionClearRef.current);
      panelTransitionClearRef.current = null;
    }

    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!reduced && transition !== null) {
      setPanelAnimEpoch((epoch) => epoch + 1);
      setPanelTransition(transition);
      panelTransitionClearRef.current = window.setTimeout(() => {
        setPanelTransition(null);
        panelTransitionClearRef.current = null;
      }, MESSAGES_PANEL_TRANSITION_CLEAR_MS);
    } else {
      setPanelTransition(null);
    }
  }, []);

  const mutePeerViaApi = useCallback(
    (peerUuid: string, muted: boolean) => {
      const viewer = me?.userUuid?.trim();
      if (!viewer || !peerUuid.trim()) return;
      const uuid = dmConversationUuid(viewer, peerUuid);
      void setChatListMuted(peerUuid, uuid, muted);
    },
    [me?.userUuid],
  );

  /** Сброс только локального until-индикатора; серверный mute не трогаем. */
  const clearLocalTemporaryMute = useCallback((peerUuid: string) => {
    setMutedPeers((prev) => {
      if (!(peerUuid in prev)) return prev;
      const next = { ...prev };
      delete next[peerUuid];
      return next;
    });
  }, []);

  const clearPeerMuted = useCallback(
    (peerUuid: string) => {
      clearLocalTemporaryMute(peerUuid);
      mutePeerViaApi(peerUuid, false);
    },
    [clearLocalTemporaryMute, mutePeerViaApi],
  );

  const setPeerMutedForever = useCallback(
    (peerUuid: string) => {
      clearLocalTemporaryMute(peerUuid);
      mutePeerViaApi(peerUuid, true);
    },
    [clearLocalTemporaryMute, mutePeerViaApi],
  );

  const setPeerMutedTemporary = useCallback(
    (peerUuid: string) => {
      // Overlay SoT — boolean mute (как Mobile). Countdown — только Web UI;
      // по истечении mute на сервере остаётся, пока пользователь не снимет явно.
      setMutedPeers((prev) => ({
        ...prev,
        [peerUuid]: { kind: "until", untilMs: Date.now() + CONVERSATION_MUTE_DEFAULT_DURATION_MS },
      }));
      mutePeerViaApi(peerUuid, true);
    },
    [mutePeerViaApi],
  );

  const getPeerMute = useCallback(
    (peerUuid: string): ConversationMuteEntry | null => {
      const local = mutedPeers[peerUuid];
      if (local && isConversationMuteActive(local)) return local;
      if (peerUuid in mutedByPeer) return { kind: "forever" };
      return null;
    },
    [mutedByPeer, mutedPeers],
  );

  const isPeerArchived = useCallback((peerUuid: string) => peerUuid in archivedByPeer, [archivedByPeer]);

  useEffect(() => {
    hydrateOverlay(me?.userUuid ?? null);
  }, [hydrateOverlay, me?.userUuid]);

  // FSCP-ORG sync only when bootstrap finished and identity keys are ready.
  useEffect(() => {
    if (!fscpBootstrapLoading && fscpMaterial) {
      setChatListOverlayFscpKeys({
        agreementPrivateKey: fscpMaterial.agreementPrivateKey,
        signingPrivateKey: fscpMaterial.signingPrivateKey,
      });
    } else {
      setChatListOverlayFscpKeys(null);
    }
  }, [fscpMaterial, fscpBootstrapLoading]);

  // Повторный GET после готовности сессии и при возврате на вкладку —
  // иначе stale localStorage выглядит как «локальные» папки без сервера.
  useEffect(() => {
    if (
      !isClient ||
      !hasToken ||
      !me?.userUuid ||
      fscpBootstrapLoading ||
      !fscpMaterial
    ) {
      return;
    }
    refreshChatListOverlay();
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshChatListOverlay();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [hasToken, isClient, me?.userUuid, fscpMaterial, fscpBootstrapLoading]);

  const customEntities = overlayState.entities;
  const customFolderDefs = useMemo(() => entitiesToFolderDefs(customEntities), [customEntities]);
  const membership = useMemo(() => membershipByEntityId(customEntities), [customEntities]);
  const knownCustomIds = useMemo(() => new Set(customEntities.map((e) => e.id)), [customEntities]);
  // Иконка Архива / лимит слотов — ORG maps (без ∩ пустого list).
  const archivedCount = useMemo(() => {
    const owner = me?.userUuid?.trim();
    const dmSet = owner
      ? dmConversationUuidsOfArchivedPeers(owner, archivedByPeer)
      : undefined;
    return countArchivedForFolderIcon(archivedByPeer, archivedByConversation, dmSet);
  }, [archivedByConversation, archivedByPeer, me?.userUuid]);
  const visibleFolders = useMemo(
    () => listVisibleChatFolders(archivedCount, customFolderDefs),
    [archivedCount, customFolderDefs],
  );
  const canCreateFolder = useMemo(
    () => canCreateChatListFolder(archivedCount, customFolderDefs.length),
    [archivedCount, customFolderDefs.length],
  );
  const canArchivePeer = useMemo(
    () => canArchiveChatListPeer(archivedCount, customFolderDefs.length),
    [archivedCount, customFolderDefs.length],
  );
  const activeFolder = normalizeChatListFolder(listFolder, archivedCount, knownCustomIds);
  const folderPickOptions = useMemo(
    () =>
      visibleFolders
        .filter((f) => f.id !== CHAT_LIST_ARCHIVE_FOLDER_ID)
        .map((f) => ({ id: f.id, label: f.label })),
    [visibleFolders],
  );

  useEffect(() => {
    if (listFolder !== activeFolder) setListFolder(activeFolder);
  }, [activeFolder, listFolder]);

  const requireOrganizerKeys = useCallback(() => {
    if (fscpMaterial) return true;
    // No silent no-op: unlock sheet (password) or open anyway so user sees FSCP state.
    openFscpUnlock();
    return false;
  }, [fscpMaterial, openFscpUnlock]);

  const archivePeer = useCallback(
    (peerUuid: string, conversationUuid?: string) => {
      const viewer = me?.userUuid?.trim();
      if (!viewer) return;
      if (!requireOrganizerKeys()) return;
      if (!canArchivePeer) {
        window.alert(
          "Нельзя архивировать: уже заняты все четыре слота иконок. Удалите папку, чтобы освободить место для Архива.",
        );
        return;
      }
      const uuid = conversationUuid?.trim() || dmConversationUuid(viewer, peerUuid);
      void (async () => {
        const ok = await setChatListArchived(peerUuid, uuid, true);
        if (!ok) {
          window.alert(
            "Нельзя архивировать: уже заняты все четыре слота иконок. Удалите папку, чтобы освободить место для Архива.",
          );
          return;
        }
        notifyMessagesUnreadChanged();
      })();
    },
    [canArchivePeer, me?.userUuid, requireOrganizerKeys],
  );

  const unarchivePeer = useCallback(
    (peerUuid: string, conversationUuid?: string) => {
      const viewer = me?.userUuid?.trim();
      if (!viewer) return;
      if (!requireOrganizerKeys()) return;
      const uuid = conversationUuid?.trim() || dmConversationUuid(viewer, peerUuid);
      void (async () => {
        await setChatListArchived(peerUuid, uuid, false);
        notifyMessagesUnreadChanged();
      })();
    },
    [me?.userUuid, requireOrganizerKeys],
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      const nowMs = Date.now();
      setMutedPeers((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [peerUuid, entry] of Object.entries(prev)) {
          if (entry.kind === "until" && entry.untilMs <= nowMs) {
            delete next[peerUuid];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const closeChat = useCallback(() => {
    if (!selectedTarget) return;
    applyPanelTransition("fromLeft");
    setSelectedTarget(null);
    setSelectedPeer(null);
  }, [applyPanelTransition, selectedTarget]);

  const archiveGroup = useCallback(
    (conversationUuid: string) => {
      const uuid = conversationUuid.trim();
      if (!uuid) return;
      if (!requireOrganizerKeys()) return;
      if (!canArchivePeer) {
        window.alert(
          "Нельзя архивировать: уже заняты все четыре слота иконок. Удалите папку, чтобы освободить место для Архива.",
        );
        return;
      }
      void (async () => {
        const ok = await setChatListGroupArchived(uuid, true);
        if (!ok) {
          window.alert(
            "Нельзя архивировать: уже заняты все четыре слота иконок. Удалите папку, чтобы освободить место для Архива.",
          );
          return;
        }
        if (selectedGroupUuid === uuid) closeChat();
        notifyMessagesUnreadChanged();
      })();
    },
    [canArchivePeer, closeChat, requireOrganizerKeys, selectedGroupUuid],
  );

  const unarchiveGroup = useCallback(
    (conversationUuid: string) => {
      const uuid = conversationUuid.trim();
      if (!uuid) return;
      if (!requireOrganizerKeys()) return;
      void (async () => {
        await setChatListGroupArchived(uuid, false);
        notifyMessagesUnreadChanged();
      })();
    },
    [requireOrganizerKeys],
  );

  const switchChat = useCallback(
    (chat: ConversationListItemDto) => {
      if (
        selectedTarget?.kind === "dm" &&
        selectedTarget.otherUserUuid === chat.otherUserUuid
      ) {
        return;
      }

      if (!selectedTarget) {
        applyPanelTransition("fromRight");
      } else if (selectedTarget.kind === "dm") {
        const prevIdx = conversationsRef.current.findIndex(
          (c) => c.otherUserUuid === selectedTarget.otherUserUuid,
        );
        const nextIdx = conversationsRef.current.findIndex(
          (c) => c.otherUserUuid === chat.otherUserUuid,
        );
        if (prevIdx !== -1 && nextIdx !== -1) {
          applyPanelTransition(nextIdx > prevIdx ? "fromBottom" : "fromTop");
        } else {
          applyPanelTransition("fromRight");
        }
      } else {
        applyPanelTransition("fromRight");
      }

      setSelectedPeer(chat);
      setSelectedTarget({ kind: "dm", otherUserUuid: chat.otherUserUuid });
    },
    [applyPanelTransition, selectedTarget],
  );

  const openGroupChat = useCallback(
    (conversationUuid: string) => {
      if (
        selectedTarget?.kind === "groupChat" &&
        selectedTarget.conversationUuid === conversationUuid
      ) {
        return;
      }
      applyPanelTransition("fromRight");
      setSelectedPeer(null);
      setSelectedTarget({ kind: "groupChat", conversationUuid });
    },
    [applyPanelTransition, selectedTarget],
  );

  const applyConversationPage = useCallback((page: MsgConversationsPage) => {
    conversationsCache.set(page);
    const list = page.items.map(toConversationDto);
    setConversations(list);
    setListError(null);
    setSelectedPeer((prev) => {
      if (!prev) return null;
      const updated = list.find((c) => c.otherUserUuid === prev.otherUserUuid);
      return updated ?? prev;
    });
  }, []);

  const refreshConversationList = useCallback(async () => {
    const page = await conversationsCache.get();
    applyConversationPage(page);
  }, [applyConversationPage]);

  /** Таймер debounce вне стейта: иначе он попал бы в deps эффекта и пересоздавался на каждом рендере. */
  const conversationListRefreshTimeoutRef = useRef<number | null>(null);

  const scheduleConversationListRefresh = useCallback(() => {
    if (conversationListRefreshTimeoutRef.current !== null) {
      window.clearTimeout(conversationListRefreshTimeoutRef.current);
    }
    conversationListRefreshTimeoutRef.current = window.setTimeout(() => {
      conversationListRefreshTimeoutRef.current = null;
      void refreshConversationList();
    }, CONVERSATION_LIST_REFRESH_DEBOUNCE_MS);
  }, [refreshConversationList]);

  useEffect(() => {
    return () => {
      if (conversationListRefreshTimeoutRef.current !== null) {
        window.clearTimeout(conversationListRefreshTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isClient) return;
    const onMessagesChanged = (event: Event) => {
      scheduleConversationListRefresh();
      void refreshGroupsRef.current?.();
      const detail = (event as CustomEvent<MessagesChangedDetail | undefined>).detail;
      const incomingConversationUuid = detail?.conversationUuid?.trim().toLowerCase();
      const signalKind = detail?.kind;
      const viewerUuid = me?.userUuid?.trim() ?? "";
      if (!incomingConversationUuid || !viewerUuid) return;

      const openGroupUuid = selectedGroupUuid?.trim().toLowerCase() ?? "";
      const openIsGroup =
        selectedTarget?.kind === "groupChat" && openGroupUuid.length > 0;
      if (
        openIsGroup &&
        incomingConversationUuid === openGroupUuid &&
        signalKind !== "dm"
      ) {
        const viewerNorm = viewerUuid.toLowerCase();
        invalidateGroupConversationThread(viewerNorm, selectedGroupUuid!);
        void (async () => {
          try {
            const page = await getGroupConversationThread(viewerNorm, selectedGroupUuid!);
            let rows = groupApiMessagesToThread(page.items);
            const pending = pendingOutgoingRef.current;
            if (pending && !rows.some((r) => r.messageUuid === pending.messageUuid)) {
              rows = mergePendingOutgoing(rows, pending);
            }
            setThreadMessages(rows);
            setThreadFetchedForViewerNorm(viewerNorm);
          } catch {
            /* keep current thread */
          }
        })();
        if (document.visibilityState !== "visible") return;
        void apiMarkGroupRead(selectedGroupUuid!)
          .then(() => {
            setGroupChats((prev) =>
              prev.map((g) =>
                g.conversationUuid === selectedGroupUuid ? { ...g, unreadCount: 0 } : g,
              ),
            );
            notifyMessagesUnreadChanged();
          })
          .catch(() => {});
        return;
      }

      if (signalKind === "groupChat") return;

      const peer = selectedOtherUuid?.trim() ?? "";
      if (!peer) return;
      const openConversationUuid = dmConversationUuid(viewerUuid, peer).toLowerCase();
      if (incomingConversationUuid !== openConversationUuid) return;

      const viewerNorm = viewerUuid.toLowerCase();
      invalidateConversationThread(viewerNorm, peer);
      void (async () => {
        try {
          const page = await getConversationThread(viewerNorm, peer);
          let rows = page.items.map(toMessageDto);
          const pending = pendingOutgoingRef.current;
          if (pending && !rows.some((r) => r.messageUuid === pending.messageUuid)) {
            rows = mergePendingOutgoing(rows, pending);
          }
          setThreadMessages(rows);
          setThreadFetchedForViewerNorm(viewerNorm);
        } catch {
          /* keep current thread */
        }
      })();

      // Parity Mobile: while the chat is open and the tab is visible, mark incoming as read
      // so the peer gets live ✓✓ without requiring re-enter.
      if (document.visibilityState !== "visible") return;
      void msgMarkReadForUser(viewerNorm, peer)
        .then(() => {
          setConversations((prev) =>
            prev.map((c) => (c.otherUserUuid === peer ? { ...c, unreadCount: 0 } : c)),
          );
          notifyMessagesUnreadChanged();
        })
        .catch(() => {
          /* не блокируем чат */
        });
    };
    window.addEventListener(MESSAGES_UNREAD_CHANGED_EVENT, onMessagesChanged);
    return () => window.removeEventListener(MESSAGES_UNREAD_CHANGED_EVENT, onMessagesChanged);
  }, [
    isClient,
    me?.userUuid,
    scheduleConversationListRefresh,
    selectedOtherUuid,
    selectedGroupUuid,
    selectedTarget?.kind,
  ]);

  useEffect(() => {
    if (!isClient) return;
    const onReadChanged = (event: Event) => {
      const detail = (event as CustomEvent<ReadChangedDetail | undefined>).detail;
      const readConversationUuid = detail?.conversationUuid?.trim().toLowerCase();
      const viewerUuid = me?.userUuid?.trim() ?? "";
      const peer = selectedOtherUuid?.trim() ?? "";
      if (!readConversationUuid || !viewerUuid || !peer) return;
      const openConversationUuid = dmConversationUuid(viewerUuid, peer).toLowerCase();
      if (readConversationUuid !== openConversationUuid) return;
      setThreadMessages((prev) =>
        prev.map((m) =>
          m.isFromMe && m.sendStatus !== "sending" ? { ...m, isRead: true } : m,
        ),
      );
    };
    window.addEventListener(READ_CHANGED_EVENT, onReadChanged);
    return () => window.removeEventListener(READ_CHANGED_EVENT, onReadChanged);
  }, [isClient, me?.userUuid, selectedOtherUuid]);

  /** Возврат во вкладку после долгого отсутствия — список должен догнать пропущенное, а не показать кэш. */
  useEffect(() => {
    if (!isClient || !hasToken) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      conversationsCache.invalidate();
      void conversationsCache.refresh().then(applyConversationPage).catch(() => {});
      const viewer = me?.userUuid?.trim() ?? "";
      const peer = selectedOtherUuid?.trim() ?? "";
      if (!viewer || !peer) return;
      void msgMarkReadForUser(viewer.toLowerCase(), peer)
        .then(() => {
          setConversations((prev) =>
            prev.map((c) => (c.otherUserUuid === peer ? { ...c, unreadCount: 0 } : c)),
          );
          notifyMessagesUnreadChanged();
        })
        .catch(() => {
          /* не блокируем чат */
        });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [isClient, hasToken, applyConversationPage, me?.userUuid, selectedOtherUuid]);

  const viewerUuid = me?.userUuid?.trim() ?? "";
  const viewerNorm = viewerUuid.toLowerCase();
  const { listPreviewDecryptedByPeer, listPreviewDecryptFailByPeer, seedListPreview } =
    useMessagesListPreviewDecrypt(conversations, fscpMaterial, viewerUuid);
  const { prefetchPeerThread } = usePreloadConversationThreads(viewerNorm, conversations, {
    viewerUuid,
    fscpMaterial,
  });
  usePreloadThreadMessageMedia(decryptedById);

  /**
   * Своя отправка удалась — строка списка и кэш обновляются локально, до ответа сервера.
   * `seedListPreview` обязан идти в том же синхронном блоке, что `setConversations`:
   * иначе эффект расшифровки увидит новый шифротекст без ключа засева, сочтёт превью
   * устаревшим и мигнёт «Расшифровка…».
   */
  const applyOutgoingToList = useCallback(
    (peerUuid: string, encryptedForMe: string, createdAt: string, plaintext: FscpMessagePlaintext) => {
      const patch: OutgoingListPatch = { peerUuid, encryptedForMe, createdAt };
      seedListPreview(peerUuid, encryptedForMe, plaintext);
      setConversations((prev) => patchConversationListForOutgoing(prev, patch));
      conversationsCache.patch((page) => patchConversationsPageForOutgoing(page, patch));
    },
    [seedListPreview],
  );

  useEffect(() => {
    if (!isClient || !hasToken) return;
    preloadMessageEmojiPicker();
  }, [isClient, hasToken]);

  useEffect(() => {
    if (!isClient || !hasToken) return;
    let cancelled = false;
    const cached = conversationsCache.peek();
    if (cached) {
      applyConversationPage(cached);
      setListLoading(false);
    } else {
      setListLoading(true);
    }
    setListError(null);
    (async () => {
      try {
        const page = await conversationsCache.get();
        if (cancelled) return;
        applyConversationPage(page);
      } catch (e) {
        if (!cancelled) {
          setListError(e instanceof ApiRequestError ? e.message : "Не удалось загрузить чаты");
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isClient, hasToken, me?.userUuid, applyConversationPage]);

  const composeResetRef = useRef(compose.reset);
  composeResetRef.current = compose.reset;

  useEffect(() => {
    setDecryptedById({});
    setDecryptFailById({});
    decryptingRef.current.clear();
    scrollTrackingReadyRef.current = false;
    prevSeenMessageIdsRef.current = new Set();
    pendingInsertLiftRef.current = false;
    atBottomRef.current = true;
    openRepinUntilRef.current = 0;
    liftActiveUntilRef.current = 0;
    setOpenRevealDeadlineElapsed(false);
    resetChatListInsertLift(messagesInnerRef.current);
    setPeerBelowScrollCount(0);
    composeResetRef.current();
    voiceRecorder.cancel();
    const deadlineTimer = window.setTimeout(() => {
      setOpenRevealDeadlineElapsed(true);
    }, MESSAGES_OPEN_REVEAL_DEADLINE_MS);
    return () => {
      window.clearTimeout(deadlineTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- сброс черновика только при смене чата/зрителя
  }, [selectedOtherUuid, selectedGroupUuid, me?.userUuid]);

  const refreshGroups = useCallback(async () => {
    if (!hasToken || !me?.userUuid) {
      setGroupChats([]);
      return;
    }
    try {
      const items = await apiListGroups();
      const viewer = me.userUuid.trim();
      const mapped = await Promise.all(
        items.map(async (item) => {
          let preview: string | null = null;
          const wire = item.lastMessageEncryptedWire?.trim();
          if (wire && fscpMaterial) {
            preview = await decryptGroupMessagePreview({
              encryptedPayload: wire,
              viewerUserUuid: viewer,
              agreementPrivateKey: fscpMaterial.agreementPrivateKey,
            });
          } else if (wire) {
            preview = "🔒";
          }
          return mapGroupListItem(item, preview);
        }),
      );
      setGroupChats((prev) => mergeGroupListRefresh(prev, mapped));
      setChatListKnownGroupUuids(mapped.map((g) => g.conversationUuid));
    } catch {
      /* keep previous list */
    }
  }, [fscpMaterial, hasToken, me?.userUuid]);

  const refreshGroupsRef = useRef(refreshGroups);
  refreshGroupsRef.current = refreshGroups;

  useEffect(() => {
    if (!isClient || !hasToken) return;
    void refreshGroups();
  }, [isClient, hasToken, refreshGroups]);

  useEffect(() => {
    if (!selectedGroupUuid) {
      setGroupMembersOpen(false);
      setGroupMembersError(null);
      setGroupMembersBusy(false);
      return;
    }
    const viewerNorm = me?.userUuid?.trim().toLowerCase() ?? "";
    if (!viewerNorm) return;
    let cancelled = false;
    setThreadLoading(true);
    setThreadError(null);
    void (async () => {
      try {
        invalidateGroupConversationThread(viewerNorm, selectedGroupUuid);
        const [page, detail] = await Promise.all([
          getGroupConversationThread(viewerNorm, selectedGroupUuid),
          apiGetGroup(selectedGroupUuid),
        ]);
        if (cancelled) return;
        setThreadMessages(groupApiMessagesToThread(page.items));
        setThreadFetchedForViewerNorm(viewerNorm);
        setGroupChats((prev) => {
          const existing = prev.find((g) => g.conversationUuid === selectedGroupUuid);
          const base = existing ?? mapGroupListItem({
            conversationUuid: detail.conversationUuid,
            title: detail.title,
            createdByUserUuid: detail.createdByUserUuid,
            createdAt: detail.createdAt,
            memberCount: detail.members.length,
            lastMessageEncryptedWire: null,
            lastMessageAt: null,
            lastMessageIsFromMe: false,
            unreadCount: 0,
          });
          const merged = mergeGroupDetail(base, detail);
          if (existing) {
            return prev.map((g) =>
              g.conversationUuid === selectedGroupUuid ? { ...merged, unreadCount: 0 } : g,
            );
          }
          return [...prev, { ...merged, unreadCount: 0 }];
        });
        await apiMarkGroupRead(selectedGroupUuid);
        notifyMessagesUnreadChanged();
      } catch (e) {
        if (!cancelled) {
          setThreadError(
            e instanceof ApiRequestError ? e.message : "Не удалось загрузить группу.",
          );
        }
      } finally {
        if (!cancelled) setThreadLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedGroupUuid, me?.userUuid]);

  useEffect(() => {
    if (!isClient || !hasToken) return;
    const withUuid = searchParams.get("with");
    if (!withUuid || !isWellFormedUuid(withUuid)) return;
    const u = searchParams.get("u") ?? "";
    const n = (searchParams.get("n") ?? u).trim();
    // alignRailScrollFromMainListRef.current = true;
    applyPanelTransition("fromRight");
    setSelectedPeer({
      otherUserUuid: withUuid,
      otherUsername: u,
      otherDisplayName: n.length > 0 ? n : u.length > 0 ? u : "Пользователь",
      lastMessageUuid: "",
      lastMessageContent: null,
      lastMessageEncryptedForMe: null,
      lastMessageIsFromMe: false,
      hasEncryptedPreview: false,
      lastMessageAt: "",
      unreadCount: 0,
      otherUserIsOnline: false,
      otherUserLastSeenAt: null,
    });
    setSelectedTarget({ kind: "dm", otherUserUuid: withUuid });
    router.replace("/messages", { scroll: false });
  }, [isClient, hasToken, router, searchParams, applyPanelTransition]);

  useEffect(() => {
    if (!isClient || !hasToken || !selectedOtherUuid) {
      if (selectedGroupUuid) return;
      threadFetchContextRef.current = { peer: null, viewerNorm: "" };
      setThreadMessages([]);
      setThreadFetchedForViewerNorm(null);
      setThreadLoading(false);
      setThreadError(null);
      return;
    }
    const viewerNorm = me?.userUuid?.trim().toLowerCase() ?? "";
    if (!viewerNorm) {
      threadFetchContextRef.current = { peer: null, viewerNorm: "" };
      setThreadMessages([]);
      setThreadFetchedForViewerNorm(null);
      setThreadLoading(false);
      setThreadError(null);
      return;
    }

    const prev = threadFetchContextRef.current;
    const contextChanged = prev.peer !== selectedOtherUuid || prev.viewerNorm !== viewerNorm;
    if (contextChanged) {
      threadFetchContextRef.current = { peer: selectedOtherUuid, viewerNorm };
      const cached = peekConversationThread(viewerNorm, selectedOtherUuid);
      if (cached) {
        setThreadMessages(cached.items.map(toMessageDto));
        setThreadFetchedForViewerNorm(viewerNorm);
        setThreadLoading(false);
      } else {
        setThreadMessages([]);
        setThreadFetchedForViewerNorm(null);
        setThreadLoading(true);
      }
    }

    let cancelled = false;
    setThreadError(null);
    if (!peekConversationThread(viewerNorm, selectedOtherUuid)) {
      setThreadLoading(true);
    }
    (async () => {
      try {
        const page = await getConversationThread(viewerNorm, selectedOtherUuid);
        const rows = page.items.map(toMessageDto);
        const pending = pendingOutgoingRef.current;
        let next = rows;
        if (pending && !rows.some((r) => r.messageUuid === pending.messageUuid)) {
          next = mergePendingOutgoing(rows, pending);
        }
        if (!cancelled) {
          setThreadMessages(next);
          setThreadFetchedForViewerNorm(viewerNorm);
        }
        try {
          await msgMarkReadForUser(viewerNorm, selectedOtherUuid);
          if (!cancelled) {
            setConversations((prev) =>
              prev.map((c) => (c.otherUserUuid === selectedOtherUuid ? { ...c, unreadCount: 0 } : c))
            );
            notifyMessagesUnreadChanged();
          }
        } catch {
          /* не блокируем чат */
        }
      } catch (e) {
        if (!cancelled) {
          setThreadError(e instanceof ApiRequestError ? e.message : "Не удалось загрузить сообщения");
          setThreadMessages([]);
          setThreadFetchedForViewerNorm(null);
        }
      } finally {
        if (!cancelled) setThreadLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isClient, hasToken, selectedOtherUuid, selectedGroupUuid, me?.userUuid]);

  const pinMessagesToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollMessagesRef.current;
    if (!el) return;
    pinMessagesScrollToBottom(el, behavior);
    atBottomRef.current = true;
  }, []);

  const jumpToLatestMessages = useCallback(() => {
    setPeerBelowScrollCount(0);
    pinMessagesToBottom("smooth");
  }, [pinMessagesToBottom]);

  const handleMessagesScroll = useCallback(() => {
    const el = scrollMessagesRef.current;
    if (!el) return;
    const nearBottom = isMessagesNearBottom(el, MESSAGES_NEAR_BOTTOM_PX);
    atBottomRef.current = nearBottom;
    if (nearBottom) setPeerBelowScrollCount(0);
  }, []);

  useEffect(() => {
    const viewerNorm = me?.userUuid?.trim().toLowerCase() ?? "";
    if (!viewerNorm || !fscpMaterial || !me) return;
    if (!threadFetchedForViewerNorm || threadFetchedForViewerNorm !== viewerNorm) return;
    setDecryptFailById({});
    for (const m of threadMessages) {
      if (decryptedById[m.messageUuid]) continue;
      const enc = m.encryptedForMe?.trim();
      if (!enc) {
        if (m.content?.trim()) continue;
        continue;
      }
      const demoPlain = parseDemoPlaintextWire(enc);
      if (demoPlain) {
        setDecryptedById((prev) => ({ ...prev, [m.messageUuid]: demoPlain }));
        continue;
      }
      if (m.content?.trim()) continue;
      if (isFscpGroupWirePayload(enc)) {
        if (decryptingRef.current.has(m.messageUuid)) continue;
        decryptingRef.current.add(m.messageUuid);
        void decryptGroupMessageWire({
          wire: enc,
          viewerUserUuid: me.userUuid.trim(),
          agreementPrivateKey: fscpMaterial.agreementPrivateKey,
        })
          .then((plain) => {
            setDecryptFailById((prev) => {
              if (!(m.messageUuid in prev)) return prev;
              const next = { ...prev };
              delete next[m.messageUuid];
              return next;
            });
            setDecryptedById((prev) => ({ ...prev, [m.messageUuid]: plain.plaintext }));
          })
          .catch(() => {
            setDecryptFailById((prev) => ({ ...prev, [m.messageUuid]: FSCP_DECRYPT_FAIL_LABEL }));
          })
          .finally(() => {
            decryptingRef.current.delete(m.messageUuid);
          });
        continue;
      }
      if (!isFscpWirePayload(enc)) continue;
      if (decryptingRef.current.has(m.messageUuid)) continue;
      decryptingRef.current.add(m.messageUuid);
      void decryptFscpWireEnvelope({
        wire: enc,
        viewerUserUuid: me.userUuid.trim(),
        agreementPrivateKey: fscpMaterial.agreementPrivateKey,
      })
        .then((plain) => {
          setDecryptFailById((prev) => {
            if (!(m.messageUuid in prev)) return prev;
            const next = { ...prev };
            delete next[m.messageUuid];
            return next;
          });
          setDecryptedById((prev) => ({ ...prev, [m.messageUuid]: plain }));
        })
        .catch(() => {
          setDecryptFailById((prev) => ({ ...prev, [m.messageUuid]: FSCP_DECRYPT_FAIL_LABEL }));
        })
        .finally(() => {
          decryptingRef.current.delete(m.messageUuid);
        });
    }
  }, [threadMessages, me?.userUuid, fscpMaterial, threadFetchedForViewerNorm]);

  const [presenceTick, setPresenceTick] = useState(0);
  const [peerTyping, setPeerTyping] = useState(false);
  const [presenceEpoch, setPresenceEpoch] = useState(() => sharedPresenceStore.getSessionEpoch());
  const typingEmitterRef = useRef<TypingEmitter | null>(null);
  const typingComposeSyncRef = useRef<{
    conv: string;
    text: string;
    mode: string;
  } | null>(null);

  useEffect(() => {
    return sharedPresenceStore.subscribe(() => {
      setPresenceTick((n) => n + 1);
      setPresenceEpoch(sharedPresenceStore.getSessionEpoch());
    });
  }, []);

  const conversationsWithPresence = useMemo(() => {
    return conversations.map((c) => {
      const overlay = sharedPresenceStore.overlayOnline(
        c.otherUserUuid,
        c.otherUserIsOnline,
        c.otherUserLastSeenAt,
      );
      return {
        ...c,
        otherUserIsOnline: overlay.isOnline,
        otherUserLastSeenAt: overlay.lastSeenAt,
      };
    });
  }, [conversations, presenceTick]);

  const filteredConversations = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    let list = filterConversationsByFolder(
      conversationsWithPresence,
      activeFolder,
      archivedByPeer,
      membership,
    );

    if (sortBy === "unread") {
      list = list.filter((item) => item.unreadCount > 0);
    }

    if (filterFrom === "communities") {
      list = list.filter(() => false);
    }
    if (filterFrom === "dev") {
      list = list.filter(() => false);
    }

    if (!query) return list;
    return list.filter((item) => {
      const preview = conversationPreview(item, listPreviewDecryptedByPeer, listPreviewDecryptFailByPeer).toLowerCase();
      return (
        item.otherDisplayName.toLowerCase().includes(query) ||
        item.otherUsername.toLowerCase().includes(query) ||
        preview.includes(query)
      );
    });
  }, [
    activeFolder,
    archivedByPeer,
    conversationsWithPresence,
    filterFrom,
    listPreviewDecryptFailByPeer,
    listPreviewDecryptedByPeer,
    membership,
    searchQuery,
    sortBy,
  ]);

  /** DM + FSCP-G group rows. Groups in «все» and «Архив» (not custom / people). */
  const mergedListItems = useMemo((): MessagesListItem[] => {
    const query = searchQuery.trim().toLowerCase();
    const items: MessagesListItem[] = filteredConversations.map((conversation) => ({
      kind: "dm",
      conversation,
    }));

    const showGroups =
      (activeFolder === "all" || activeFolder === "archived") && filterFrom === "all";
    if (showGroups) {
      let groups = filterGroupsByFolder(groupChats, activeFolder, archivedByConversation);
      if (sortBy === "unread") {
        groups = groups.filter((g) => g.unreadCount > 0);
      }
      if (query) {
        groups = groups.filter((g) => {
          const title = g.title.toLowerCase();
          const preview = (g.lastMessagePreview ?? "").toLowerCase();
          return title.includes(query) || preview.includes(query);
        });
      }
      for (const group of groups) {
        items.push({ kind: "groupChat", group });
      }
    }

    items.sort((a, b) => {
      const at =
        a.kind === "dm"
          ? Date.parse(a.conversation.lastMessageAt || "") || 0
          : Date.parse(a.group.lastMessageAt || a.group.createdAt || "") || 0;
      const bt =
        b.kind === "dm"
          ? Date.parse(b.conversation.lastMessageAt || "") || 0
          : Date.parse(b.group.lastMessageAt || b.group.createdAt || "") || 0;
      return bt - at;
    });
    return items;
  }, [
    activeFolder,
    archivedByConversation,
    filterFrom,
    filteredConversations,
    groupChats,
    searchQuery,
    sortBy,
  ]);

  const selectedGroupChat = useMemo(() => {
    if (!selectedGroupUuid) return null;
    return groupChats.find((g) => g.conversationUuid === selectedGroupUuid) ?? null;
  }, [groupChats, selectedGroupUuid]);

  const groupChatMe = useMemo((): GroupMember | null => {
    const uuid = me?.userUuid?.trim();
    if (!uuid || !me) return null;
    const username = (me.username ?? "").replace(/^@+/, "") || "me";
    const displayName = profileDisplayName(me.displayName ?? "", me.username ?? "") || username;
    return { userUuid: uuid, username, displayName };
  }, [me]);

  // const railInteractive = mergedListItems.length > 0;
  // const railScrollRef = useRef<HTMLDivElement>(null);

  const activeConversationsCount = useMemo(
    () => conversations.filter((item) => !isPeerArchived(item.otherUserUuid)).length,
    [conversations, isPeerArchived],
  );

  const archivedConversationsCount = useMemo(
    () => conversations.filter((item) => isPeerArchived(item.otherUserUuid)).length,
    [conversations, isPeerArchived],
  );

  const selectedConversationUuid = useMemo(() => {
    const viewer = me?.userUuid?.trim();
    const peer = selectedOtherUuid?.trim();
    if (!viewer || !peer) return null;
    return dmConversationUuid(viewer, peer);
  }, [me?.userUuid, selectedOtherUuid]);

  const chatHeaderPeer = useMemo((): ConversationListItemDto | null => {
    if (!selectedOtherUuid) return null;
    const fromList = conversationsWithPresence.find((c) => c.otherUserUuid === selectedOtherUuid);
    const base =
      fromList ??
      (selectedPeer?.otherUserUuid === selectedOtherUuid
        ? selectedPeer
        : {
            otherUserUuid: selectedOtherUuid,
            otherUsername: "",
            otherDisplayName: "Пользователь",
            lastMessageUuid: "",
            lastMessageContent: null,
            lastMessageEncryptedForMe: null,
            lastMessageIsFromMe: false,
            hasEncryptedPreview: false,
            lastMessageAt: "",
            unreadCount: 0,
            otherUserIsOnline: false,
            otherUserLastSeenAt: null,
          });
    const overlay = sharedPresenceStore.overlayOnline(
      base.otherUserUuid,
      base.otherUserIsOnline,
      base.otherUserLastSeenAt,
    );
    return {
      ...base,
      otherUserIsOnline: overlay.isOnline,
      otherUserLastSeenAt: overlay.lastSeenAt,
    };
  }, [conversationsWithPresence, selectedOtherUuid, selectedPeer, presenceTick]);

  useEffect(() => {
    const uuids = conversations.map((c) => c.otherUserUuid);
    if (selectedOtherUuid) uuids.push(selectedOtherUuid);
    if (!sharedPresenceStore.surfacesAccepted) {
      return () => sharedPresenceStore.unregisterSurface("messages");
    }
    sharedPresenceStore.registerSurface("messages", uuids);
    void sharedPresenceStore.resyncSnapshots().catch(() => {});
    return () => sharedPresenceStore.unregisterSurface("messages");
  }, [conversations, selectedOtherUuid, presenceEpoch]);

  useEffect(() => {
    if (!selectedConversationUuid || !selectedOtherUuid) {
      setPeerTyping(false);
      return undefined;
    }
    let clearTimer: number | null = null;
    const onTyping = (ev: Event) => {
      const detail = (ev as CustomEvent<TypingChangedDetail>).detail;
      if (!detail) return;
      if (detail.conversationUuid.trim().toLowerCase() !== selectedConversationUuid.trim().toLowerCase()) {
        return;
      }
      if (detail.userUuid.trim().toLowerCase() !== selectedOtherUuid.trim().toLowerCase()) return;
      if (clearTimer != null) window.clearTimeout(clearTimer);
      clearTimer = null;
      setPeerTyping(detail.isTyping);
      if (detail.isTyping) {
        clearTimer = window.setTimeout(() => {
          clearTimer = null;
          setPeerTyping(false);
        }, PRESENCE_TYPING_PEER_TTL_MS);
      }
    };
    window.addEventListener(TYPING_CHANGED_EVENT, onTyping);
    return () => {
      window.removeEventListener(TYPING_CHANGED_EVENT, onTyping);
      if (clearTimer != null) window.clearTimeout(clearTimer);
      setPeerTyping(false);
    };
  }, [selectedConversationUuid, selectedOtherUuid]);

  useEffect(() => {
    if (!selectedConversationUuid || !selectedOtherUuid) {
      typingEmitterRef.current?.dispose();
      typingEmitterRef.current = null;
      return undefined;
    }
    const conv = selectedConversationUuid;
    const other = selectedOtherUuid;
    const emitter = createTypingEmitter({
      postTyping: (isTyping) => apiPostTyping(conv, isTyping, other),
      onTrueHeartbeat: () => {
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        return apiPresenceHeartbeat();
      },
    });
    typingEmitterRef.current?.dispose();
    typingEmitterRef.current = emitter;
    return () => {
      emitter.dispose();
      if (typingEmitterRef.current === emitter) typingEmitterRef.current = null;
    };
  }, [selectedConversationUuid, selectedOtherUuid]);

  useEffect(() => {
    const emitter = typingEmitterRef.current;
    if (!emitter || !selectedConversationUuid) return;

    const prev = typingComposeSyncRef.current;
    const convChanged = !prev || prev.conv !== selectedConversationUuid;
    const textChanged = !!prev && prev.text !== compose.text;
    typingComposeSyncRef.current = {
      conv: selectedConversationUuid,
      text: compose.text,
      mode: compose.mode,
    };

    if (compose.mode !== "text") {
      emitter.stop();
      return;
    }
    // Leftover draft after chat switch / initial open must not claim typing.
    if (convChanged && !textChanged) return;
    emitter.onText(compose.text);
  }, [compose.text, compose.mode, selectedConversationUuid, selectedOtherUuid]);

  const messagesPageTitle = useMemo(() => {
    if (selectedGroupChat) return selectedGroupChat.title;
    if (!chatHeaderPeer) return null;
    return profileDisplayName(chatHeaderPeer.otherDisplayName, chatHeaderPeer.otherUsername);
  }, [chatHeaderPeer, selectedGroupChat]);

  useFloraPageTitleOverride(messagesPageTitle);

  const [presenceClock, setPresenceClock] = useState(0);
  useEffect(() => {
    if (!selectedOtherUuid) return undefined;
    const id = window.setInterval(() => {
      setPresenceClock((c) => c + 1);
    }, 30000);
    return () => window.clearInterval(id);
  }, [selectedOtherUuid]);

  const chatHeaderPresenceLine = useMemo(() => {
    if (!chatHeaderPeer) return null;
    if (peerTyping) {
      return { kind: "typing" as const, aria: "Собеседник печатает" as const };
    }
    if (chatHeaderPeer.otherUserIsOnline) {
      return { kind: "text" as const, text: "В сети", aria: "В сети" as const };
    }
    const was = formatWasOnlineRu(chatHeaderPeer.otherUserLastSeenAt, new Date());
    if (was) return { kind: "text" as const, text: was, aria: was };
    return { kind: "text" as const, text: "Не в сети", aria: "Не в сети" as const };
  }, [chatHeaderPeer, presenceClock, peerTyping]);

  /** Единая модель шапки открытого чата: один JSX, разные данные / ⋮. */
  const openChatHeader = useMemo(() => {
    if (selectedGroupChat) {
      const membersLabel = formatGroupMembersLabel(
        selectedGroupChat.memberCount || selectedGroupChat.members.length,
      );
      return {
        kind: "group" as const,
        title: selectedGroupChat.title,
        handle: null as string | null,
        profileHref: null as string | null,
        status: { kind: "text" as const, text: membersLabel, aria: membersLabel },
        online: false,
        avatar: {
          kind: "group" as const,
          title: selectedGroupChat.title,
          seed: selectedGroupChat.conversationUuid,
        },
        more: {
          chatMenuKind: "group" as const,
          conversationIsMuted: false,
          accessibility: {
            dialog: `Меню группы «${selectedGroupChat.title}»`,
            triggerOpen: `Действия — ${selectedGroupChat.title}`,
            triggerClose: "Закрыть меню группы",
          },
        },
      };
    }
    if (!chatHeaderPeer) return null;
    const title =
      chatHeaderPeer.otherDisplayName || chatHeaderPeer.otherUsername || "Пользователь";
    const handle = chatHeaderPeer.otherUsername.replace(/^@+/, "") || "…";
    const profileSlug =
      chatHeaderPeer.otherUsername.replace(/^@+/, "") || chatHeaderPeer.otherUserUuid;
    return {
      kind: "dm" as const,
      title,
      handle,
      profileHref: `/profile/${encodeURIComponent(profileSlug)}`,
      status: chatHeaderPresenceLine,
      online: chatHeaderPeer.otherUserIsOnline,
      avatar: {
        kind: "dm" as const,
        displayName: chatHeaderPeer.otherDisplayName || chatHeaderPeer.otherUsername || "Пользователь",
        username: chatHeaderPeer.otherUsername,
        seed: chatHeaderPeer.otherUserUuid,
      },
      more: {
        chatMenuKind: "dm" as const,
        conversationIsMuted: selectedOtherUuid
          ? getPeerMute(selectedOtherUuid) !== null
          : false,
        accessibility: {
          dialog: `Меню чата с ${chatHeaderPeer.otherDisplayName || chatHeaderPeer.otherUsername}`,
          triggerOpen: `Действия — ${chatHeaderPeer.otherDisplayName || chatHeaderPeer.otherUsername}`,
          triggerClose: "Закрыть меню чата",
        },
      },
    };
  }, [
    selectedGroupChat,
    chatHeaderPeer,
    chatHeaderPresenceLine,
    selectedOtherUuid,
    getPeerMute,
  ]);

  // Mini-rail (временно скрыт ниже в JSX). Источник: mergedListItems.slice(0, 16)
  // — DM + groupChat. Active: selectedTarget.kind === "dm" | "groupChat".
  // const railChatsSource = useMemo(() => mergedListItems.slice(0, 16), [mergedListItems]);

  // useLayoutEffect(() => {
  //   const scrollEl = railScrollRef.current;
  //   if (!scrollEl || !selectedTarget) return;
  //   ...
  // }, [selectedTarget, railChatsSource]);

  const displayMessageContent = useCallback(
    (m: MessageThreadItemDto): FscpMessagePlaintext | "decrypting" | "failed" => {
      if (decryptedById[m.messageUuid]) return decryptedById[m.messageUuid];
      const enc = m.encryptedForMe?.trim();
      if (enc) {
        const demoPlain = parseDemoPlaintextWire(enc);
        if (demoPlain) return demoPlain;
        if (decryptFailById[m.messageUuid]) return "failed";
        if (isFscpWirePayload(enc) || isFscpGroupWirePayload(enc)) return "decrypting";
      }
      if (m.content?.trim()) return messagePlaintextFromText(m.content);
      return messagePlaintextFromText("—");
    },
    [decryptedById, decryptFailById]
  );

  const visibleThreadMessages = useMemo(
    () =>
      threadMessages.filter(
        (m) => m.isFromMe || displayMessageContent(m) !== "decrypting",
      ),
    [threadMessages, displayMessageContent],
  );

  const threadRenderItems = useMemo(
    () =>
      buildThreadRenderItems(
        threadMessages,
        (m) => m.isFromMe || displayMessageContent(m) !== "decrypting",
      ),
    [threadMessages, displayMessageContent],
  );

  const peerThreadAvatarLabel = useMemo(
    () =>
      avatarLetters(
        chatHeaderPeer?.otherDisplayName || chatHeaderPeer?.otherUsername || "?",
      ),
    [chatHeaderPeer?.otherDisplayName, chatHeaderPeer?.otherUsername],
  );

  /**
   * Open pin + insertLift до paint (useLayoutEffect).
   * useEffect+rAF давал кадр «прыжка» до counter-lift — визуальное дергание.
   */
  useLayoutEffect(() => {
    if (!selectedOtherUuid && !selectedGroupUuid) return;
    if (threadLoading) {
      scrollTrackingReadyRef.current = false;
      return;
    }
    if (threadMessages.length === 0) {
      scrollTrackingReadyRef.current = false;
      return;
    }

    const el = scrollMessagesRef.current;
    if (!el) return;

    const hasPeerDecrypting = threadMessages.some(
      (m) => !m.isFromMe && displayMessageContent(m) === "decrypting",
    );
    const openReady = !hasPeerDecrypting || openRevealDeadlineElapsed;

    if (!scrollTrackingReadyRef.current) {
      if (!openReady) return;
      scrollTrackingReadyRef.current = true;
      prevSeenMessageIdsRef.current = new Set(threadMessages.map((m) => m.messageUuid));
      atBottomRef.current = true;
      openRepinUntilRef.current = performance.now() + MESSAGES_REPIN_WINDOW_MS;
      pinMessagesToBottom("auto");
      return;
    }

    const prev = prevSeenMessageIdsRef.current;
    const newly = visibleThreadMessages.filter((m) => !prev.has(m.messageUuid));
    for (const m of visibleThreadMessages) {
      prev.add(m.messageUuid);
    }
    if (newly.length === 0) return;

    const peerNew = newly.filter((m) => !m.isFromMe);
    const ownNew = newly.filter((m) => m.isFromMe);
    const nearBottom =
      atBottomRef.current || isMessagesNearBottom(el, MESSAGES_NEAR_BOTTOM_PX);

    const runInsertLift = (
      rows: MessageThreadItemDto[],
      opts?: { holdTrailingPeerAvatar?: boolean },
    ) => {
      const inner = messagesInnerRef.current;
      const estimated = rows.reduce(
        (sum, m) => sum + estimateMessageInsertLiftPx(displayMessageContent(m)),
        0,
      );
      const measured = inner
        ? measureTrailingBubblesInsertLiftPx(inner, rows.length)
        : 0;
      const heightPx = measured > 0 ? measured : estimated;
      const now = performance.now();
      liftActiveUntilRef.current = now + CHAT_INSERT_LIFT_MS + 64;
      openRepinUntilRef.current = now + MESSAGES_REPIN_WINDOW_MS;
      // Синхронно до paint: pin + translateY(H). Иначе виден скачок layout.
      pinMessagesToBottom("auto");
      if (!inner) return;
      const holdAvatar =
        opts?.holdTrailingPeerAvatar === true ? queryTrailingPeerAvatar(inner) : null;
      playChatListInsertLift(
        inner,
        heightPx,
        holdAvatar ? { holdViewportEls: [holdAvatar] } : undefined,
      );
    };

    if (peerNew.length > 0) {
      if (nearBottom) {
        setPeerBelowScrollCount(0);
        // Hold только если аватар уже был на экране (append в группу).
        // Новая peer-группа — аватар едет вместе с сообщением в insertLift.
        const trailing = threadRenderItems[threadRenderItems.length - 1];
        const newlyPeerUuids = new Set(peerNew.map((m) => m.messageUuid));
        const holdAvatar =
          trailing?.kind === "peerGroup" &&
          shouldHoldTrailingPeerAvatar(trailing.messages, newlyPeerUuids);
        runInsertLift(peerNew, { holdTrailingPeerAvatar: holdAvatar });
      } else {
        setPeerBelowScrollCount((c) => Math.min(99, c + peerNew.length));
      }
      return;
    }

    if (pendingInsertLiftRef.current && ownNew.length > 0) {
      pendingInsertLiftRef.current = false;
      runInsertLift(ownNew);
    }
  }, [
    threadMessages,
    visibleThreadMessages,
    threadRenderItems,
    threadLoading,
    selectedOtherUuid,
    selectedGroupUuid,
    openRevealDeadlineElapsed,
    displayMessageContent,
    pinMessagesToBottom,
  ]);

  useEffect(() => {
    if (!selectedOtherUuid && !selectedGroupUuid) return;
    const scrollEl = scrollMessagesRef.current;
    if (!scrollEl) return;

    const maybeRepin = () => {
      if (!scrollTrackingReadyRef.current) return;
      const now = performance.now();
      // Не двигаем scrollTop во время insertLift — иначе transform и pin дерутся.
      if (now < liftActiveUntilRef.current) return;
      const inWindow = now < openRepinUntilRef.current;
      if (!atBottomRef.current && !inWindow) return;
      pinMessagesToBottom("auto");
    };

    const ro = new ResizeObserver(() => {
      maybeRepin();
    });
    ro.observe(scrollEl);
    const inner = messagesInnerRef.current;
    if (inner) ro.observe(inner);
    const view = messagesChatViewRef.current;
    if (view) ro.observe(view);
    return () => ro.disconnect();
  }, [selectedOtherUuid, selectedGroupUuid, threadMessages.length, pinMessagesToBottom]);

  const copyMessageContent = useCallback(async (content: FscpMessagePlaintext | "decrypting" | "failed") => {
    if (content === "decrypting" || content === "failed") return;
    const text = plaintextToPreview(content);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const peerReplyDisplayName =
    chatHeaderPeer?.otherDisplayName || chatHeaderPeer?.otherUsername || "Пользователь";

  const beginReplyToMessage = useCallback(
    (message: MessageThreadItemDto) => {
      if (message.sendStatus === "sending") return;
      const draft = replyDraftFromMessage(message, displayMessageContent(message), peerReplyDisplayName);
      if (!draft) return;
      setReplyTo(draft);
      requestCloseStickerPanel();
      queueMicrotask(() => composeInputRef.current?.focus());
    },
    [displayMessageContent, peerReplyDisplayName, requestCloseStickerPanel],
  );

  const handleDeleteMessage = useCallback(
    async (message: MessageThreadItemDto) => {
      if (!message.isFromMe || !selectedOtherUuid || !me?.userUuid) return;
      if (!window.confirm("Удалить сообщение? Оно исчезнет у обоих участников.")) return;
      setThreadError(null);
      try {
        await msgDeleteMessageForUser(me.userUuid, selectedOtherUuid, message.messageUuid);
        setThreadMessages((prev) => prev.filter((m) => m.messageUuid !== message.messageUuid));
        setDecryptedById((prev) => {
          const next = { ...prev };
          delete next[message.messageUuid];
          return next;
        });
        invalidateConversationThread(viewerNorm, selectedOtherUuid);
        await refreshConversationList();
      } catch (e) {
        setThreadError(
          e instanceof ApiRequestError ? e.message : "Не удалось удалить сообщение.",
        );
      }
    },
    [me?.userUuid, refreshConversationList, selectedOtherUuid, viewerNorm],
  );

  const deleteConversationCloseTimerRef = useRef<number | null>(null);

  const dismissDeleteConversationModal = useCallback(() => {
    setDeleteConversationModalClosing(true);
    if (deleteConversationCloseTimerRef.current) {
      window.clearTimeout(deleteConversationCloseTimerRef.current);
    }
    deleteConversationCloseTimerRef.current = window.setTimeout(() => {
      setPendingDeleteConversation(null);
      setDeleteConversationModalClosing(false);
      setDeleteConversationError(null);
      deleteConversationCloseTimerRef.current = null;
    }, DELETE_CONVERSATION_MODAL_CLOSE_MS);
  }, []);

  useEffect(
    () => () => {
      if (deleteConversationCloseTimerRef.current) {
        window.clearTimeout(deleteConversationCloseTimerRef.current);
      }
    },
    [],
  );

  const handleDeleteConversation = useCallback(
    async (peerUuid: string) => {
      const peer = peerUuid.trim();
      const myUuid = me?.userUuid?.trim();
      if (!peer || !myUuid) return;

      const deletingOpenChat = selectedOtherUuid === peer;
      setDeleteConversationBusy(true);
      setDeleteConversationError(null);

      try {
        if (isDevLocalOfflineSession()) {
          devDemoDeleteConversation(peer);
        } else {
          await msgDeleteConversationForUser(myUuid, peer);
        }

        invalidateConversationThread(viewerNorm, peer);
        conversationsCache.invalidate();
        clearPeerMuted(peer);
        unarchivePeer(peer);
        setConversations((prev) => prev.filter((c) => c.otherUserUuid !== peer));

        if (deletingOpenChat) {
          closeChat();
        }

        notifyMessagesUnreadChanged();
        dismissDeleteConversationModal();
      } catch (e) {
        setDeleteConversationError(
          e instanceof ApiRequestError ? e.message : "Не удалось удалить чат.",
        );
      } finally {
        setDeleteConversationBusy(false);
      }
    },
    [
      clearPeerMuted,
      closeChat,
      dismissDeleteConversationModal,
      me?.userUuid,
      selectedOtherUuid,
      unarchivePeer,
      viewerNorm,
    ],
  );

  const openDeleteConversationModal = useCallback((peerUuid: string, displayName: string) => {
    if (deleteConversationCloseTimerRef.current) {
      window.clearTimeout(deleteConversationCloseTimerRef.current);
      deleteConversationCloseTimerRef.current = null;
    }
    setDeleteConversationError(null);
    setDeleteConversationModalClosing(false);
    setPendingDeleteConversation({ kind: "dm", peerUuid, displayName });
  }, []);

  const openDeleteGroupModal = useCallback((conversationUuid: string, displayName: string) => {
    if (deleteConversationCloseTimerRef.current) {
      window.clearTimeout(deleteConversationCloseTimerRef.current);
      deleteConversationCloseTimerRef.current = null;
    }
    setDeleteConversationError(null);
    setDeleteConversationModalClosing(false);
    setPendingDeleteConversation({ kind: "group", conversationUuid, displayName });
  }, []);

  const closeDeleteConversationModal = useCallback(() => {
    if (deleteConversationBusy) return;
    dismissDeleteConversationModal();
  }, [deleteConversationBusy, dismissDeleteConversationModal]);

  const handleDeleteGroup = useCallback(
    (conversationUuid: string) => {
      const uuid = conversationUuid.trim();
      if (!uuid) return;
      const deletingOpen = selectedGroupUuid === uuid;
      setDeleteConversationBusy(true);
      setDeleteConversationError(null);
      void (async () => {
        try {
          await apiLeaveGroup(uuid);
          setGroupChats((prev) => prev.filter((g) => g.conversationUuid !== uuid));
          if (deletingOpen) closeChat();
          dismissDeleteConversationModal();
          notifyMessagesUnreadChanged();
        } catch (e) {
          setDeleteConversationError(
            e instanceof ApiRequestError ? e.message : "Не удалось выйти из группы.",
          );
        } finally {
          setDeleteConversationBusy(false);
        }
      })();
    },
    [closeChat, dismissDeleteConversationModal, selectedGroupUuid],
  );

  const applyGroupDetailLocal = useCallback((detail: Awaited<ReturnType<typeof apiGetGroup>>) => {
    setGroupChats((prev) => {
      const existing = prev.find((g) => g.conversationUuid === detail.conversationUuid);
      const base =
        existing ??
        mapGroupListItem({
          conversationUuid: detail.conversationUuid,
          title: detail.title,
          createdByUserUuid: detail.createdByUserUuid,
          createdAt: detail.createdAt,
          memberCount: detail.members.length,
          lastMessageEncryptedWire: null,
          lastMessageAt: null,
          lastMessageIsFromMe: false,
          unreadCount: 0,
        });
      const merged = mergeGroupDetail(base, detail);
      if (existing) {
        return prev.map((g) =>
          g.conversationUuid === detail.conversationUuid ? merged : g,
        );
      }
      return [merged, ...prev];
    });
  }, []);

  const handleGroupSaveTitle = useCallback(
    async (nextTitle: string): Promise<boolean> => {
      const uuid = selectedGroupUuid?.trim();
      if (!uuid) return false;
      setGroupMembersBusy(true);
      setGroupMembersError(null);
      try {
        const detail = await apiPatchGroupTitle(uuid, nextTitle);
        applyGroupDetailLocal(detail);
        return true;
      } catch (e) {
        setGroupMembersError(
          e instanceof ApiRequestError ? e.message : "Не удалось сохранить название.",
        );
        return false;
      } finally {
        setGroupMembersBusy(false);
      }
    },
    [applyGroupDetailLocal, selectedGroupUuid],
  );

  const handleGroupRemoveMember = useCallback(
    async (userUuid: string): Promise<boolean> => {
      const uuid = selectedGroupUuid?.trim();
      const target = userUuid.trim();
      if (!uuid || !target) return false;
      setGroupMembersBusy(true);
      setGroupMembersError(null);
      try {
        await apiRemoveGroupMember(uuid, target);
        const detail = await apiGetGroup(uuid);
        applyGroupDetailLocal(detail);
        return true;
      } catch (e) {
        setGroupMembersError(
          e instanceof ApiRequestError ? e.message : "Не удалось удалить участника.",
        );
        return false;
      } finally {
        setGroupMembersBusy(false);
      }
    },
    [applyGroupDetailLocal, selectedGroupUuid],
  );

  const handleGroupAddMember = useCallback(
    async (userUuid: string): Promise<boolean> => {
      const uuid = selectedGroupUuid?.trim();
      const target = userUuid.trim();
      if (!uuid || !target) return false;
      setGroupMembersBusy(true);
      setGroupMembersError(null);
      try {
        const { ok, missing } = await filterMembersWithE2eKeys([target]);
        if (missing.length > 0 || ok.length === 0) {
          setGroupMembersError(
            "У участника нет ключа шифрования. Пусть один раз войдёт в аккаунт.",
          );
          return false;
        }
        const detail = await apiAddGroupMember(uuid, ok[0]!);
        applyGroupDetailLocal(detail);
        return true;
      } catch (e) {
        setGroupMembersError(
          e instanceof ApiRequestError ? e.message : "Не удалось добавить участника.",
        );
        return false;
      } finally {
        setGroupMembersBusy(false);
      }
    },
    [applyGroupDetailLocal, selectedGroupUuid],
  );

  const confirmDeleteConversation = useCallback(() => {
    if (!pendingDeleteConversation) return;
    if (pendingDeleteConversation.kind === "group") {
      handleDeleteGroup(pendingDeleteConversation.conversationUuid);
      return;
    }
    void handleDeleteConversation(pendingDeleteConversation.peerUuid);
  }, [handleDeleteConversation, handleDeleteGroup, pendingDeleteConversation]);

  // Safety number 1:1 (FSCP §Safety number) — модал «Проверка шифрования».
  // Паттерн pending* как у delete-модала: peer фиксируется в момент открытия,
  // поэтому смена/закрытие чата не требует сброса состояния в эффекте.
  const [pendingSafetyNumber, setPendingSafetyNumber] = useState<{
    peerUuid: string;
    displayName: string;
  } | null>(null);
  const [safetyNumberClosing, setSafetyNumberClosing] = useState(false);
  const safetyNumberCloseTimerRef = useRef<number | null>(null);

  const openSafetyNumberModal = useCallback((peerUuid: string, displayName: string) => {
    if (safetyNumberCloseTimerRef.current) {
      window.clearTimeout(safetyNumberCloseTimerRef.current);
      safetyNumberCloseTimerRef.current = null;
    }
    setSafetyNumberClosing(false);
    setPendingSafetyNumber({ peerUuid, displayName });
  }, []);

  const closeSafetyNumberModal = useCallback(() => {
    setSafetyNumberClosing(true);
    if (safetyNumberCloseTimerRef.current) {
      window.clearTimeout(safetyNumberCloseTimerRef.current);
    }
    safetyNumberCloseTimerRef.current = window.setTimeout(() => {
      setPendingSafetyNumber(null);
      setSafetyNumberClosing(false);
      safetyNumberCloseTimerRef.current = null;
    }, DELETE_CONVERSATION_MODAL_CLOSE_MS);
  }, []);

  useEffect(
    () => () => {
      if (safetyNumberCloseTimerRef.current) {
        window.clearTimeout(safetyNumberCloseTimerRef.current);
      }
    },
    [],
  );

  /**
   * TOFU-ключ собеседника для safety number: `senderSigningPublicKeyBase64Url`
   * из последнего **успешно расшифрованного** входящего wire (подпись конверта
   * уже проверена в decryptFscpWireEnvelope). До первого входящего — null,
   * модал показывает заглушку (сессия ещё не ready, FSCP.md §Safety number).
   * threadMessages принадлежат selectedOtherUuid — ключ валиден только пока
   * зафиксированный в модале peer совпадает с открытым чатом.
   */
  const peerIdentityPublicKeyB64 = useMemo(() => {
    if (!pendingSafetyNumber || pendingSafetyNumber.peerUuid !== selectedOtherUuid) return null;
    for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
      const m = threadMessages[i];
      if (!m || m.isFromMe) continue;
      if (!decryptedById[m.messageUuid]) continue;
      const enc = m.encryptedForMe?.trim();
      if (!enc || !isFscpWirePayload(enc)) continue;
      try {
        const raw = fromBase64Flexible(enc.slice(FSCP_WIRE_PREFIX.length));
        const env = JSON.parse(new TextDecoder().decode(raw)) as {
          senderSigningPublicKeyBase64Url?: string;
        };
        const pk = env.senderSigningPublicKeyBase64Url?.trim();
        if (pk) return pk;
      } catch {
        /* повреждённый конверт — пробуем более ранний */
      }
    }
    return null;
  }, [decryptedById, pendingSafetyNumber, selectedOtherUuid, threadMessages]);

  useEffect(() => {
    setReplyTo(null);
  }, [selectedOtherUuid, selectedGroupUuid]);

  const handleAttachPick = useCallback(
    (kind: ComposeAttachKind, files: FileList) => {
      const isGroup = selectedTarget?.kind === "groupChat";
      if (kind === "photo") {
        const result = compose.mergeImages(files);
        const err = messageImageAttachError(result);
        if (err) {
          setThreadError(err);
          return;
        }
        setThreadError(null);
        return;
      }
      if (isGroup || kind !== "video") return;
      const file = files[0];
      if (!file) return;
      const attachError = messageVideoAttachError(file);
      if (attachError) {
        setThreadError(attachError);
        return;
      }
      setThreadError(null);
      compose.addVideoFromFile(file);
    },
    [compose, selectedTarget],
  );

  const sendVoiceMessageOptimistic = useCallback(async () => {
    if (!selectedOtherUuid || compose.mode !== "voice" || !compose.voice) return;
    const myUuid = me?.userUuid;
    if (!myUuid) {
      setThreadError("Профиль не загружен. Обновите страницу.");
      return;
    }

    const voice = compose.voice;
    if (voice.durationMs > VOICE_MAX_DURATION_MS) {
      setThreadError("Голосовое длиннее 30 минут.");
      return;
    }

    const peerUuid = selectedOtherUuid;
    const viewerNorm = myUuid.trim().toLowerCase();
    const activeReply = replyTo;
    const optimisticMessageUuid = floraNewUuid();
    const tempAssetUuid = voice.id;
    const e2ePeerHint =
      "Отправка только с end-to-end шифрованием (FSCP). У собеседника нет ключа на сервере  -  пусть он один раз войдёт в свой аккаунт.";

    const optimisticVoicePayload = plaintextFromBlocks([
      {
        kind: "voice",
        assetUuid: tempAssetUuid,
        durationMs: voice.durationMs,
        waveform: voice.waveform,
        contentType: voice.contentType,
        encryption: { algorithm: "aes-gcm", keyBase64Url: "pending", nonceBase64Url: "pending" },
      },
    ]);
    const optimisticPayload = activeReply
      ? attachReplyToPayload(optimisticVoicePayload, activeReply)
      : optimisticVoicePayload;

    registerPendingVoiceBlob(tempAssetUuid, voice.blob);
    markVoiceSendStarted(tempAssetUuid);
    const preparedVoicePromise = awaitPreparedVoiceWithFallback(
      scheduleVoiceTranscode(tempAssetUuid, voice.blob),
      { blob: voice.blob, contentType: voice.contentType },
    );

    const optimisticRow: MessageThreadItemDto = {
      messageUuid: optimisticMessageUuid,
      content: null,
      encryptedForMe: devPlaintextWire(optimisticPayload),
      createdAt: new Date().toISOString(),
      isFromMe: true,
      sendStatus: "sending",
    };

    compose.reset();
    setReplyTo(null);
    setThreadError(null);
    setDecryptedById((prev) => ({ ...prev, [optimisticMessageUuid]: optimisticPayload }));
    pendingInsertLiftRef.current = true;
    setThreadMessages((prev) => [...prev, optimisticRow]);

    const removeOptimistic = () => {
      if (selectedOtherUuidRef.current !== peerUuid) return;
      setThreadMessages((prev) => prev.filter((m) => m.messageUuid !== optimisticMessageUuid));
      setDecryptedById((prev) => {
        const next = { ...prev };
        delete next[optimisticMessageUuid];
        return next;
      });
    };

    try {
      if (isDevLocalOfflineSession()) {
        let voiceBlob: Blob;
        let voiceContentType: string;
        try {
          const prepared = await preparedVoicePromise;
          voiceBlob = prepared.blob;
          voiceContentType = prepared.contentType;
        } catch (voiceTranscodeError) {
          console.error("voice prepare failed", voiceTranscodeError);
          voiceBlob = voice.blob;
          voiceContentType = voice.contentType.trim() || voice.blob.type || "audio/webm";
        }

        if (voiceBlob.size > VOICE_MAX_UPLOAD_BYTES) {
          throw new Error("Голосовое слишком большое для отправки.");
        }

        devRegisterVoiceBlob(tempAssetUuid, voiceBlob);
        const devVoicePayload = plaintextFromBlocks([
          {
            kind: "voice",
            assetUuid: tempAssetUuid,
            durationMs: voice.durationMs,
            waveform: voice.waveform,
            contentType: voiceContentType,
            encryption: { algorithm: "aes-gcm", keyBase64Url: "demo", nonceBase64Url: "demo" },
          },
        ]);
        const finalPayload = activeReply ? attachReplyToPayload(devVoicePayload, activeReply) : devVoicePayload;
        const sent = devDemoAppendOutgoingMessage(peerUuid, finalPayload);
        const devWire = devPlaintextWire(finalPayload);
        const realRow: MessageThreadItemDto = {
          messageUuid: sent.messageUuid,
          content: null,
          encryptedForMe: devWire,
          createdAt: sent.createdAt,
          isFromMe: true,
          isRead: false,
        };
        if (selectedOtherUuidRef.current === peerUuid) {
          setDecryptedById((prev) => {
            const next = { ...prev };
            delete next[optimisticMessageUuid];
            next[sent.messageUuid] = finalPayload;
            return next;
          });
          noteOptimisticUuidReplace(
            prevSeenMessageIdsRef.current,
            optimisticMessageUuid,
            sent.messageUuid,
          );
          setThreadMessages((prev) => replaceOptimisticOutgoing(prev, optimisticMessageUuid, realRow));
          setThreadFetchedForViewerNorm(viewerNorm);
        }
        applyOutgoingToList(peerUuid, devWire, sent.createdAt, finalPayload);
        await refreshConversationList();
        return;
      }

      if (!fscpMaterial) {
        if (fscpBootstrapLoading) {
          throw new Error("Ключ шифрования ещё загружается. Подождите секунду или обновите страницу.");
        }
        if (fscpBootstrapError) {
          throw new Error(`FSCP: ${fscpBootstrapError}`);
        }
        throw new Error("Ключ шифрования недоступен. Обновите страницу.");
      }

      const peerPublicKeyPromise = (async () => {
        try {
          const peer = await apiGetUserE2ePublicKey(peerUuid);
          const peerPublicKey = peer.publicKeyBase64.trim();
          if (peerPublicKey.length === 0) {
            throw new Error(e2ePeerHint);
          }
          return peerPublicKey;
        } catch (err) {
          if (err instanceof ApiRequestError && err.status === 404) {
            throw new Error(e2ePeerHint);
          }
          throw err;
        }
      })();

      let voiceBlob: Blob;
      let voiceContentType: string;
      let peerPublicKey: string;

      const prepared = await preparedVoicePromise;
      voiceBlob = prepared.blob;
      voiceContentType = prepared.contentType;

      try {
        peerPublicKey = await peerPublicKeyPromise;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
          throw new Error(e2ePeerHint);
        }
        if (err instanceof Error && err.message === e2ePeerHint) {
          throw err;
        }
        throw err;
      }

      if (voiceBlob.size > VOICE_MAX_UPLOAD_BYTES) {
        throw new Error("Голосовое слишком большое для отправки.");
      }

      const encrypted = await encryptVoiceBlob(voiceBlob);
      const uploaded = await apiUploadMessageVoiceAsset({
        toUserUuid: peerUuid,
        encryptedBlob: encrypted.encryptedBlob,
        durationMs: voice.durationMs,
      });
      registerPendingVoiceBlob(uploaded.voiceAssetUuid, voiceBlob);

      const sentVoicePayload = plaintextFromBlocks([
        {
          kind: "voice",
          assetUuid: uploaded.voiceAssetUuid,
          durationMs: voice.durationMs,
          waveform: voice.waveform,
          contentType: voiceContentType,
          encryption: {
            algorithm: "aes-gcm",
            keyBase64Url: encrypted.keyBase64Url,
            nonceBase64Url: encrypted.nonceBase64Url,
          },
        },
      ]);
      const finalPayload = activeReply ? attachReplyToPayload(sentVoicePayload, activeReply) : sentVoicePayload;

      const peerPub = fromBase64Flexible(peerPublicKey);
      const wire = await buildFscpWireEnvelope({
        senderUserUuid: myUuid,
        receiverUserUuid: peerUuid,
        senderAgreementPrivateKey: fscpMaterial.agreementPrivateKey,
        senderSigningPrivateKey: fscpMaterial.signingPrivateKey,
        receiverAgreementPublicKey: peerPub,
        messagePayload: finalPayload,
      });
      const encryptedPushPreviews = await buildWebEncryptedPushPreviews({
        wire,
        recipientUserUuid: peerUuid,
        signingPrivateKey: fscpMaterial.signingPrivateKey,
        plaintext: finalPayload,
      });

      const sent = await msgSendMessageToUser(myUuid, peerUuid, wire, {
        voiceAssetUuids: [uploaded.voiceAssetUuid],
        encryptedPushPreviews,
      });

      const realRow: MessageThreadItemDto = {
        messageUuid: sent.messageUuid,
        content: null,
        encryptedForMe: wire,
        createdAt: sent.createdAt,
        isFromMe: true,
        isRead: false,
      };

      applyOutgoingToList(peerUuid, sent.encryptedForMe || wire, sent.createdAt, finalPayload);

      if (selectedOtherUuid === peerUuid) {
        pendingOutgoingRef.current = realRow;
        setDecryptedById((prev) => {
          const next = { ...prev };
          delete next[optimisticMessageUuid];
          next[sent.messageUuid] = finalPayload;
          return next;
        });
        try {
          invalidateConversationThread(viewerNorm, peerUuid);
          let rows = (await getConversationThread(viewerNorm, peerUuid)).items.map(toMessageDto);
          if (!rows.some((r) => r.messageUuid === sent.messageUuid)) {
            await new Promise((r) => setTimeout(r, 450));
            invalidateConversationThread(viewerNorm, peerUuid);
            rows = (await getConversationThread(viewerNorm, peerUuid)).items.map(toMessageDto);
          }
          noteOptimisticUuidReplace(
            prevSeenMessageIdsRef.current,
            optimisticMessageUuid,
            realRow.messageUuid,
          );
          setThreadMessages(replaceOptimisticOutgoing(rows, optimisticMessageUuid, realRow));
          setThreadFetchedForViewerNorm(viewerNorm);
        } catch {
          noteOptimisticUuidReplace(
            prevSeenMessageIdsRef.current,
            optimisticMessageUuid,
            realRow.messageUuid,
          );
          setThreadMessages((prev) => replaceOptimisticOutgoing(prev, optimisticMessageUuid, realRow));
          setThreadFetchedForViewerNorm(viewerNorm);
        } finally {
          pendingOutgoingRef.current = null;
          clearPendingVoiceBlob(uploaded.voiceAssetUuid);
        }
      } else {
        clearPendingVoiceBlob(uploaded.voiceAssetUuid);
      }

      void conversationsCache
        .refresh()
        .then(applyConversationPage)
        .catch(() => {});
    } catch (e) {
      removeOptimistic();
      setThreadError(
        e instanceof ApiRequestError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Не удалось отправить голосовое сообщение."
      );
    } finally {
      markVoiceSendFinished(tempAssetUuid);
      clearPendingVoiceBlob(tempAssetUuid);
    }
  }, [
    applyConversationPage,
    applyOutgoingToList,
    compose,
    fscpBootstrapError,
    fscpBootstrapLoading,
    fscpMaterial,
    me?.userUuid,
    refreshConversationList,
    replyTo,
    selectedOtherUuid,
  ]);

  const resolveGroupMemberUuids = useCallback(async (): Promise<string[] | null> => {
    if (!selectedGroupUuid) return null;
    let memberUuids =
      selectedGroupChat?.members.map((m) => m.userUuid).filter(Boolean) ?? [];
    if (memberUuids.length >= 2) return memberUuids;
    try {
      const detail = await apiGetGroup(selectedGroupUuid);
      memberUuids = detail.members.map((m) => m.userUuid);
      setGroupChats((prev) =>
        prev.map((g) =>
          g.conversationUuid === selectedGroupUuid ? mergeGroupDetail(g, detail) : g,
        ),
      );
      return memberUuids;
    } catch (e) {
      setThreadError(
        e instanceof ApiRequestError ? e.message : "Не удалось загрузить участников группы.",
      );
      return null;
    }
  }, [selectedGroupChat?.members, selectedGroupUuid]);

  const sendGroupVoiceMessageOptimistic = useCallback(async () => {
    if (
      selectedTarget?.kind !== "groupChat" ||
      !selectedGroupUuid ||
      compose.mode !== "voice" ||
      !compose.voice
    ) {
      return;
    }
    const myUuid = me?.userUuid?.trim();
    if (!myUuid) {
      setThreadError("Профиль не загружен. Обновите страницу.");
      return;
    }
    const voice = compose.voice;
    if (voice.durationMs > VOICE_MAX_DURATION_MS) {
      setThreadError("Голосовое длиннее 30 минут.");
      return;
    }
    if (fscpBootstrapLoading) {
      setThreadError("Ключи шифрования ещё загружаются…");
      return;
    }
    if (!fscpMaterial) {
      setThreadError(
        fscpBootstrapError
          ? `FSCP: ${fscpBootstrapError}`
          : "Нужно разблокировать ключи шифрования, чтобы писать в группу.",
      );
      if (fscpStatusNeedsPassword(fscpStatus)) openFscpUnlock();
      return;
    }
    const memberUuids = await resolveGroupMemberUuids();
    if (!memberUuids || memberUuids.length < 2) return;

    const groupUuid = selectedGroupUuid;
    const optimisticMessageUuid = floraNewUuid();
    const tempAssetUuid = voice.id;
    const optimisticVoicePayload = plaintextFromBlocks([
      {
        kind: "voice",
        assetUuid: tempAssetUuid,
        durationMs: voice.durationMs,
        waveform: voice.waveform,
        contentType: voice.contentType,
        encryption: { algorithm: "aes-gcm", keyBase64Url: "pending", nonceBase64Url: "pending" },
      },
    ]);
    registerPendingVoiceBlob(tempAssetUuid, voice.blob);
    markVoiceSendStarted(tempAssetUuid);
    const preparedVoicePromise = awaitPreparedVoiceWithFallback(
      scheduleVoiceTranscode(tempAssetUuid, voice.blob),
      { blob: voice.blob, contentType: voice.contentType },
    );

    const pendingRow: MessageThreadItemDto = {
      messageUuid: optimisticMessageUuid,
      content: null,
      encryptedForMe: null,
      createdAt: new Date().toISOString(),
      isFromMe: true,
      senderUserUuid: myUuid,
      sendStatus: "sending",
    };
    pendingInsertLiftRef.current = true;
    pendingOutgoingRef.current = pendingRow;
    setThreadMessages((prev) => [...prev, pendingRow]);
    setDecryptedById((prev) => ({ ...prev, [optimisticMessageUuid]: optimisticVoicePayload }));
    compose.reset();
    setReplyTo(null);
    setThreadError(null);

    const removeOptimistic = () => {
      setThreadMessages((prev) => prev.filter((m) => m.messageUuid !== optimisticMessageUuid));
      setDecryptedById((prev) => {
        const next = { ...prev };
        delete next[optimisticMessageUuid];
        return next;
      });
      pendingOutgoingRef.current = null;
    };

    try {
      const prepared = await preparedVoicePromise;
      if (prepared.blob.size > VOICE_MAX_UPLOAD_BYTES) {
        throw new Error("Голосовое слишком большое для отправки.");
      }
      const encrypted = await encryptVoiceBlob(prepared.blob);
      const uploaded = await apiUploadGroupVoiceAsset({
        conversationUuid: groupUuid,
        encryptedBlob: encrypted.encryptedBlob,
        durationMs: voice.durationMs,
      });
      registerPendingVoiceBlob(uploaded.voiceAssetUuid, prepared.blob);
      const finalPayload = plaintextFromBlocks([
        {
          kind: "voice",
          assetUuid: uploaded.voiceAssetUuid,
          durationMs: voice.durationMs,
          waveform: voice.waveform,
          contentType: prepared.contentType,
          encryption: {
            algorithm: "aes-gcm",
            keyBase64Url: encrypted.keyBase64Url,
            nonceBase64Url: encrypted.nonceBase64Url,
          },
        },
      ]);
      const wire = await buildGroupBlocksMessageWire({
        conversationUuid: groupUuid,
        senderUserUuid: myUuid,
        material: fscpMaterial,
        memberUserUuids: memberUuids,
        blocks: finalPayload.blocks,
      });
      const sent = await apiSendGroupMessage(groupUuid, wire, {
        voiceAssetUuids: [uploaded.voiceAssetUuid],
      });
      const realRow: MessageThreadItemDto = {
        messageUuid: sent.messageUuid,
        content: null,
        encryptedForMe: sent.encryptedWire,
        createdAt: sent.createdAt,
        isFromMe: true,
        senderUserUuid: myUuid,
      };
      pendingOutgoingRef.current = realRow;
      setDecryptedById((prev) => {
        const next = { ...prev };
        delete next[optimisticMessageUuid];
        next[sent.messageUuid] = finalPayload;
        return next;
      });
      invalidateGroupConversationThread(myUuid.toLowerCase(), groupUuid);
      const page = await getGroupConversationThread(myUuid.toLowerCase(), groupUuid);
      noteOptimisticUuidReplace(
        prevSeenMessageIdsRef.current,
        optimisticMessageUuid,
        sent.messageUuid,
      );
      setThreadMessages(groupApiMessagesToThread(page.items));
      pendingOutgoingRef.current = null;
      clearPendingVoiceBlob(uploaded.voiceAssetUuid);
      void refreshGroups();
    } catch (e) {
      removeOptimistic();
      setThreadError(
        e instanceof ApiRequestError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Не удалось отправить голосовое сообщение.",
      );
    } finally {
      markVoiceSendFinished(tempAssetUuid);
      clearPendingVoiceBlob(tempAssetUuid);
    }
  }, [
    compose,
    fscpBootstrapError,
    fscpBootstrapLoading,
    fscpMaterial,
    fscpStatus,
    me?.userUuid,
    openFscpUnlock,
    refreshGroups,
    resolveGroupMemberUuids,
    selectedGroupUuid,
    selectedTarget?.kind,
  ]);

  const handleSend = useCallback(async () => {
    if (selectedTarget?.kind === "groupChat" && selectedGroupUuid && groupChatMe) {
      if (compose.mode === "voice") {
        void sendGroupVoiceMessageOptimistic();
        return;
      }
      if (!compose.canSend) return;
      if (sending) return;
      const textBody = compose.text.trim();
      const pendingImages = compose.images;
      if (compose.videos.length > 0) {
        setThreadError("Видео в групповых чатах пока не поддерживается.");
        return;
      }
      if (!textBody && pendingImages.length === 0) return;
      const myUuid = me?.userUuid?.trim();
      if (!myUuid) {
        setThreadError("Профиль не загружен. Обновите страницу.");
        return;
      }
      if (fscpBootstrapLoading) {
        setThreadError("Ключи шифрования ещё загружаются…");
        return;
      }
      if (!fscpMaterial) {
        setThreadError(
          fscpBootstrapError
            ? `FSCP: ${fscpBootstrapError}`
            : "Нужно разблокировать ключи шифрования, чтобы писать в группу.",
        );
        if (fscpStatusNeedsPassword(fscpStatus)) openFscpUnlock();
        return;
      }
      const memberUuids = await resolveGroupMemberUuids();
      if (!memberUuids || memberUuids.length < 2) return;

      pendingInsertLiftRef.current = true;
      setSending(true);
      setThreadError(null);
      const tempUuid = `pending-group-${Date.now()}`;
      const optimisticBlocks: FscpMessageBlock[] = [];
      if (textBody) optimisticBlocks.push({ kind: "text", body: textBody });
      for (const image of pendingImages) {
        optimisticBlocks.push({
          kind: "image",
          assetUuid: image.id,
          contentType: image.sourceFile.type || "image/jpeg",
          encryption: { algorithm: "aes-gcm", keyBase64Url: "pending", nonceBase64Url: "pending" },
        });
      }
      const optimisticPayload = plaintextFromBlocks(
        optimisticBlocks.length > 0 ? optimisticBlocks : [{ kind: "text", body: textBody }],
      );
      const pendingRow: MessageThreadItemDto = {
        messageUuid: tempUuid,
        content: textBody || null,
        encryptedForMe: null,
        createdAt: new Date().toISOString(),
        isFromMe: true,
        senderUserUuid: myUuid,
        sendStatus: "sending",
      };
      pendingOutgoingRef.current = pendingRow;
      setThreadMessages((prev) => [...prev, pendingRow]);
      setDecryptedById((prev) => ({ ...prev, [tempUuid]: optimisticPayload }));
      const imageSendIds = pendingImages.map((image) => image.id);
      compose.reset();
      setReplyTo(null);
      try {
        const blocks: FscpMessageBlock[] = [];
        const imageAssetUuids: string[] = [];
        if (textBody) blocks.push({ kind: "text", body: textBody });
        if (pendingImages.length > 0) {
          for (const imageId of imageSendIds) markMessageImageSendStarted(imageId);
          try {
            const preparedImages = await Promise.all(
              pendingImages.map((image) =>
                scheduleMessageImagePrepare(image.id, image.sourceFile),
              ),
            );
            for (let index = 0; index < pendingImages.length; index += 1) {
              const prepared = preparedImages[index];
              if (!prepared) continue;
              const friBlob = await encodeImageBlobToFrc(prepared.blob, 85);
              if (friBlob.size > MAX_MESSAGE_IMAGE_BYTES) {
                throw new Error("FRC-I версия фото превышает лимит 5 МиБ.");
              }
              const encryptedFrc = await encryptVoiceBlob(friBlob);
              const frcUploaded = await apiUploadGroupImageAsset({
                conversationUuid: selectedGroupUuid,
                encryptedBlob: encryptedFrc.encryptedBlob,
                contentType: friBlob.type,
              });
              imageAssetUuids.push(frcUploaded.imageAssetUuid);
              blocks.push({
                kind: "image",
                assetUuid: frcUploaded.imageAssetUuid,
                contentType: friBlob.type,
                encryption: {
                  algorithm: "aes-gcm",
                  keyBase64Url: encryptedFrc.keyBase64Url,
                  nonceBase64Url: encryptedFrc.nonceBase64Url,
                },
              });
            }
          } finally {
            for (const imageId of imageSendIds) markMessageImageSendFinished(imageId);
          }
        }
        const wire =
          blocks.length === 1 && blocks[0]?.kind === "text"
            ? await buildGroupTextMessageWire({
                conversationUuid: selectedGroupUuid,
                senderUserUuid: myUuid,
                material: fscpMaterial,
                memberUserUuids: memberUuids,
                text: textBody,
              })
            : await buildGroupBlocksMessageWire({
                conversationUuid: selectedGroupUuid,
                senderUserUuid: myUuid,
                material: fscpMaterial,
                memberUserUuids: memberUuids,
                blocks,
              });
        const sent = await apiSendGroupMessage(selectedGroupUuid, wire, {
          imageAssetUuids: imageAssetUuids.length > 0 ? imageAssetUuids : undefined,
        });
        const finalPayload = plaintextFromBlocks(blocks);
        const realRow: MessageThreadItemDto = {
          messageUuid: sent.messageUuid,
          content: null,
          encryptedForMe: sent.encryptedWire,
          createdAt: sent.createdAt,
          isFromMe: true,
          senderUserUuid: myUuid,
        };
        pendingOutgoingRef.current = realRow;
        setDecryptedById((prev) => {
          const next = { ...prev };
          delete next[tempUuid];
          next[sent.messageUuid] = finalPayload;
          return next;
        });
        invalidateGroupConversationThread(myUuid.toLowerCase(), selectedGroupUuid);
        const page = await getGroupConversationThread(myUuid.toLowerCase(), selectedGroupUuid);
        setThreadMessages(groupApiMessagesToThread(page.items));
        pendingOutgoingRef.current = null;
        void refreshGroups();
      } catch (e) {
        setThreadMessages((prev) => prev.filter((m) => m.messageUuid !== tempUuid));
        setDecryptedById((prev) => {
          const next = { ...prev };
          delete next[tempUuid];
          return next;
        });
        pendingOutgoingRef.current = null;
        setThreadError(
          e instanceof ApiRequestError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Не удалось отправить сообщение в группу.",
        );
      } finally {
        setSending(false);
      }
      return;
    }

    if (!selectedOtherUuid || !compose.canSend) return;
    typingEmitterRef.current?.stop();
    if (compose.mode === "voice") {
      void sendVoiceMessageOptimistic();
      return;
    }
    if (sending) return;

    const myUuid = me?.userUuid;
    if (!myUuid) {
      setThreadError("Профиль не загружен. Обновите страницу.");
      return;
    }

    const textBody = compose.text.trim();
    const pendingImages = compose.images;
    const pendingVideos = compose.videos;
    if (!textBody && pendingImages.length === 0 && pendingVideos.length === 0) return;

    setSending(true);
    setThreadError(null);
    const e2ePeerHint =
      "Отправка только с end-to-end шифрованием (FSCP). У собеседника нет ключа на сервере  -  пусть он один раз войдёт в свой аккаунт.";
    let optimisticMessageUuid: string | null = null;
    try {
      const activeReply = replyTo;
      const withReply = (payload: FscpMessagePlaintext) =>
        activeReply ? attachReplyToPayload(payload, activeReply) : payload;
      let messagePayload: FscpMessagePlaintext;
      let imageAssetUuids: string[] = [];
      let videoAssetUuids: string[] = [];

      const blocks: FscpMessageBlock[] = [];
      if (textBody) blocks.push({ kind: "text", body: textBody });
      if (isDevLocalOfflineSession()) {
        for (const image of pendingImages) {
          markMessageImageSendStarted(image.id);
        }
        for (const video of pendingVideos) {
          markMessageVideoSendStarted(video.id);
        }
        try {
          const preparedImages = await Promise.all(
            pendingImages.map((image) => scheduleMessageImagePrepare(image.id, image.sourceFile)),
          );
          const preparedVideos = await Promise.all(
            pendingVideos.map((video) => scheduleMessageVideoPrepare(video.id, video.sourceFile)),
          );
          for (const prepared of preparedImages) {
            const assetUuid = floraNewUuid();
            devRegisterImageBlob(assetUuid, prepared.blob);
            blocks.push({
              kind: "image",
              assetUuid,
              contentType: prepared.contentType,
              encryption: { algorithm: "aes-gcm", keyBase64Url: "demo", nonceBase64Url: "demo" },
            });
          }
          for (let index = 0; index < pendingVideos.length; index += 1) {
            const video = pendingVideos[index];
            const prepared = preparedVideos[index];
            if (!video || !prepared) continue;
            devRegisterVideoBlob(video.id, prepared.blob);
            blocks.push({
              kind: "video",
              assetUuid: video.id,
              contentType: prepared.contentType,
              durationMs: prepared.durationMs,
              width: prepared.width,
              height: prepared.height,
              encryption: { algorithm: "aes-gcm", keyBase64Url: "demo", nonceBase64Url: "demo" },
            });
          }
        } catch (prepareError) {
          setThreadError(
            prepareError instanceof Error
              ? prepareError.message
              : "Не удалось подготовить медиа к отправке.",
          );
          return;
        } finally {
          for (const image of pendingImages) markMessageImageSendFinished(image.id);
          for (const video of pendingVideos) markMessageVideoSendFinished(video.id);
        }
        messagePayload =
          blocks.length === 1 && blocks[0]?.kind === "text"
            ? messagePlaintextFromText(textBody)
            : plaintextFromBlocks(blocks);
      } else if (pendingImages.length === 0 && pendingVideos.length === 0) {
        messagePayload = messagePlaintextFromText(textBody);
      } else {
        messagePayload = plaintextFromBlocks(blocks);
      }

      if (isDevLocalOfflineSession()) {
        const outgoingPayload = withReply(messagePayload);
        const sent = devDemoAppendOutgoingMessage(selectedOtherUuid, outgoingPayload);
        compose.reset();
        setReplyTo(null);
        const viewerNorm = myUuid.trim().toLowerCase();
        setDecryptedById((prev) => ({ ...prev, [sent.messageUuid]: outgoingPayload }));
        pendingInsertLiftRef.current = true;
        setThreadMessages(devDemoGetThread(selectedOtherUuid));
        setThreadFetchedForViewerNorm(viewerNorm);
        applyOutgoingToList(
          selectedOtherUuid,
          devPlaintextWire(outgoingPayload),
          sent.createdAt,
          outgoingPayload,
        );
        await refreshConversationList();
        return;
      }

      if (!fscpMaterial) {
        if (fscpBootstrapLoading) {
          setThreadError("Ключ шифрования ещё загружается. Подождите секунду или обновите страницу.");
          return;
        }
        if (fscpBootstrapError) {
          setThreadError(`FSCP: ${fscpBootstrapError}`);
          return;
        }
        setThreadError("Ключ шифрования недоступен. Обновите страницу.");
        return;
      }
      const peerPublicKeyPromise = (async () => {
        try {
          const peer = await apiGetUserE2ePublicKey(selectedOtherUuid);
          const peerPublicKey = peer.publicKeyBase64.trim();
          if (peerPublicKey.length === 0) {
            throw new Error(e2ePeerHint);
          }
          return peerPublicKey;
        } catch (err) {
          if (err instanceof ApiRequestError && err.status === 404) {
            throw new Error(e2ePeerHint);
          }
          throw err;
        }
      })();

      const imageSendIds = pendingImages.map((image) => image.id);
      const videoSendIds = pendingVideos.map((video) => video.id);
      for (const imageId of imageSendIds) markMessageImageSendStarted(imageId);
      for (const videoId of videoSendIds) markMessageVideoSendStarted(videoId);

      let peerPublicKey: string;
      try {
        const imagePreparePromises = pendingImages.map((image) =>
          scheduleMessageImagePrepare(image.id, image.sourceFile),
        );
        const videoPreparePromises = pendingVideos.map((video) =>
          scheduleMessageVideoPrepare(video.id, video.sourceFile),
        );
        const [resolvedPeerPublicKey, ...preparedMedia] = await Promise.all([
          peerPublicKeyPromise,
          ...imagePreparePromises,
          ...videoPreparePromises,
        ]);
        peerPublicKey = resolvedPeerPublicKey;

        if (pendingImages.length > 0 || pendingVideos.length > 0) {
          const preparedImages = preparedMedia.slice(0, pendingImages.length) as Awaited<
            ReturnType<typeof scheduleMessageImagePrepare>
          >[];
          const preparedVideos = preparedMedia.slice(pendingImages.length) as Awaited<
            ReturnType<typeof scheduleMessageVideoPrepare>
          >[];

          const blocks: FscpMessageBlock[] = [];
          if (textBody) blocks.push({ kind: "text", body: textBody });
          for (let index = 0; index < pendingImages.length; index += 1) {
            const prepared = preparedImages[index];
            if (!prepared) continue;
            const friBlob = await encodeImageBlobToFrc(prepared.blob, 85);
            if (friBlob.size > MAX_MESSAGE_IMAGE_BYTES) {
              throw new Error("FRC-I версия фото превышает лимит 5 МиБ.");
            }
            const encryptedFrc = await encryptVoiceBlob(friBlob);
            const frcUploaded = await apiUploadMessageImageAsset({
              toUserUuid: selectedOtherUuid,
              encryptedBlob: encryptedFrc.encryptedBlob,
              contentType: friBlob.type,
            });
            imageAssetUuids.push(frcUploaded.imageAssetUuid);
            blocks.push({
              kind: "image",
              assetUuid: frcUploaded.imageAssetUuid,
              contentType: friBlob.type,
              encryption: {
                algorithm: "aes-gcm",
                keyBase64Url: encryptedFrc.keyBase64Url,
                nonceBase64Url: encryptedFrc.nonceBase64Url,
              },
            });
          }
          for (let index = 0; index < pendingVideos.length; index += 1) {
            const prepared = preparedVideos[index];
            if (!prepared) continue;
            const encrypted = await encryptVoiceBlob(prepared.blob);
            const uploaded = await apiUploadMessageVideoAsset({
              toUserUuid: selectedOtherUuid,
              encryptedBlob: encrypted.encryptedBlob,
              contentType: prepared.contentType,
              durationMs: prepared.durationMs,
            });
            videoAssetUuids.push(uploaded.videoAssetUuid);
            blocks.push({
              kind: "video",
              assetUuid: uploaded.videoAssetUuid,
              contentType: prepared.contentType,
              durationMs: prepared.durationMs,
              width: prepared.width,
              height: prepared.height,
              encryption: {
                algorithm: "aes-gcm",
                keyBase64Url: encrypted.keyBase64Url,
                nonceBase64Url: encrypted.nonceBase64Url,
              },
            });
          }
          messagePayload = plaintextFromBlocks(blocks);
        }
      } catch (prepareError) {
        if (prepareError instanceof Error && prepareError.message === e2ePeerHint) {
          setThreadError(e2ePeerHint);
          return;
        }
        setThreadError(
          prepareError instanceof Error
            ? prepareError.message
            : "Не удалось подготовить медиа к отправке.",
        );
        return;
      } finally {
        for (const imageId of imageSendIds) markMessageImageSendFinished(imageId);
        for (const videoId of videoSendIds) markMessageVideoSendFinished(videoId);
      }

      const peerPub = fromBase64Flexible(peerPublicKey);
      const outgoingPayload = withReply(messagePayload);
      const wire = await buildFscpWireEnvelope({
        senderUserUuid: myUuid,
        receiverUserUuid: selectedOtherUuid,
        senderAgreementPrivateKey: fscpMaterial.agreementPrivateKey,
        senderSigningPrivateKey: fscpMaterial.signingPrivateKey,
        receiverAgreementPublicKey: peerPub,
        messagePayload: outgoingPayload,
      });
      const encryptedPushPreviews = await buildWebEncryptedPushPreviews({
        wire,
        recipientUserUuid: selectedOtherUuid,
        signingPrivateKey: fscpMaterial.signingPrivateKey,
        plaintext: outgoingPayload,
      });

      optimisticMessageUuid = floraNewUuid();
      const optimisticUuid = optimisticMessageUuid;
      const optimisticRow: MessageThreadItemDto = {
        messageUuid: optimisticUuid,
        content: null,
        encryptedForMe: wire,
        createdAt: new Date().toISOString(),
        isFromMe: true,
        sendStatus: "sending",
      };
      setDecryptedById((prev) => ({ ...prev, [optimisticUuid]: outgoingPayload }));
      pendingInsertLiftRef.current = true;
      setThreadMessages((prev) => mergePendingOutgoing(prev, optimisticRow));

      const sent = await msgSendMessageToUser(myUuid, selectedOtherUuid, wire, {
        imageAssetUuids,
        videoAssetUuids,
        encryptedPushPreviews,
      });
      compose.reset();
      setReplyTo(null);
      const viewerNorm = myUuid.trim().toLowerCase();

      const pendingRow: MessageThreadItemDto = {
        messageUuid: sent.messageUuid,
        content: null,
        encryptedForMe: wire,
        createdAt: sent.createdAt,
        isFromMe: true,
        isRead: false,
      };
      pendingOutgoingRef.current = pendingRow;
      setDecryptedById((prev) => {
        const next = { ...prev, [sent.messageUuid]: outgoingPayload };
        if (optimisticMessageUuid) delete next[optimisticMessageUuid];
        return next;
      });
      applyOutgoingToList(
        selectedOtherUuid,
        sent.encryptedForMe || wire,
        sent.createdAt,
        outgoingPayload,
      );

      try {
        invalidateConversationThread(viewerNorm, selectedOtherUuid);
        let rows = (await getConversationThread(viewerNorm, selectedOtherUuid)).items.map(toMessageDto);
        if (!rows.some((r) => r.messageUuid === sent.messageUuid)) {
          await new Promise((r) => setTimeout(r, 450));
          invalidateConversationThread(viewerNorm, selectedOtherUuid);
          rows = (await getConversationThread(viewerNorm, selectedOtherUuid)).items.map(toMessageDto);
        }
        if (optimisticMessageUuid) {
          noteOptimisticUuidReplace(
            prevSeenMessageIdsRef.current,
            optimisticMessageUuid,
            sent.messageUuid,
          );
        }
        const next = mergePendingOutgoing(rows, pendingRow);
        setThreadMessages(next);
        setThreadFetchedForViewerNorm(viewerNorm);
      } catch {
        if (optimisticMessageUuid) {
          noteOptimisticUuidReplace(
            prevSeenMessageIdsRef.current,
            optimisticMessageUuid,
            pendingRow.messageUuid,
          );
        }
        setThreadMessages((prev) =>
          optimisticMessageUuid
            ? replaceOptimisticOutgoing(prev, optimisticMessageUuid, pendingRow)
            : mergePendingOutgoing(prev, pendingRow),
        );
        setThreadFetchedForViewerNorm(viewerNorm);
      } finally {
        pendingOutgoingRef.current = null;
      }
      void conversationsCache
        .refresh()
        .then(applyConversationPage)
        .catch(() => {});
    } catch (e) {
      const failedOptimisticUuid = optimisticMessageUuid;
      if (failedOptimisticUuid) {
        setThreadMessages((prev) => prev.filter((m) => m.messageUuid !== failedOptimisticUuid));
        setDecryptedById((prev) => {
          const next = { ...prev };
          delete next[failedOptimisticUuid];
          return next;
        });
      }
      setThreadError(
        e instanceof ApiRequestError ? e.message : "Не удалось отправить зашифрованное сообщение (FSCP)."
      );
    } finally {
      setSending(false);
    }
  }, [
    applyConversationPage,
    applyOutgoingToList,
    compose,
    fscpBootstrapError,
    fscpBootstrapLoading,
    fscpMaterial,
    fscpStatus,
    openFscpUnlock,
    me?.userUuid,
    refreshConversationList,
    refreshGroups,
    replyTo,
    selectedOtherUuid,
    selectedGroupUuid,
    selectedGroupChat,
    selectedTarget,
    groupChatMe,
    resolveGroupMemberUuids,
    sendGroupVoiceMessageOptimistic,
    sendVoiceMessageOptimistic,
    sending,
  ]);

  useEffect(() => {
    if (!sendVoiceAfterRecordingRef.current || voiceRecorder.recording || !compose.voice) return;
    sendVoiceAfterRecordingRef.current = false;
    void handleSend();
  }, [compose.voice, handleSend, voiceRecorder.recording]);

  const startVoiceRecording = useCallback(() => {
    if (sending || threadLoading) return;
    requestCloseStickerPanel();
    prefetchVoiceTranscodeEngine();
    compose.clearVoice();
    compose.openVoiceMode();
    void voiceRecorder.start();
  }, [compose, requestCloseStickerPanel, sending, threadLoading, voiceRecorder]);

  const discardVoiceRecording = useCallback(() => {
    sendVoiceAfterRecordingRef.current = false;
    voiceRecorder.cancel();
    compose.clearVoice();
    compose.openTextMode();
  }, [compose, voiceRecorder]);

  const stopVoiceRecording = useCallback(() => {
    sendVoiceAfterRecordingRef.current = false;
    voiceRecorder.stop();
  }, [voiceRecorder]);

  const insertComposeToken = useCallback(
    (value: string) => {
      if (sending || threadLoading) return;

      const input = composeInputRef.current;
      const current = compose.text;
      const start = input?.selectionStart ?? current.length;
      const end = input?.selectionEnd ?? current.length;
      const next = `${current.slice(0, start)}${value}${current.slice(end)}`;
      const caret = start + value.length;

      compose.setText(next);
      window.requestAnimationFrame(() => {
        composeInputRef.current?.focus();
        composeInputRef.current?.setSelectionRange(caret, caret);
      });
    },
    [compose, sending, threadLoading],
  );

  const sendVoiceCompose = useCallback(() => {
    if (voiceRecorder.recording) {
      sendVoiceAfterRecordingRef.current = true;
      voiceRecorder.stop();
      return;
    }
    void handleSend();
  }, [handleSend, voiceRecorder]);

  const chatOpenAnimClassName = messagesChatOpenAnimClassName(panelTransition, {
    fromRight: styles.messagesChatAnimFromRight,
    fromBottom: styles.messagesChatAnimFromBottom,
    fromTop: styles.messagesChatAnimFromTop,
  });

  const isGroupChatOpen = selectedTarget?.kind === "groupChat";
  const composeBusy = sending || threadLoading;
  const composeMediaDisabled = composeBusy;
  const composeStickersDisabled = composeBusy || isGroupChatOpen;

  useEffect(() => {
    if (!isGroupChatOpen) return;
    if (stickerPanelRendered) requestCloseStickerPanel();
  }, [isGroupChatOpen, stickerPanelRendered, requestCloseStickerPanel]);

  const voiceComposeActive = compose.mode === "voice" || voiceRecorder.recording || compose.voice !== null;
  const voiceComposeSource = voiceRecorder.recording ? voiceRecorder.liveWaveform : compose.voice?.waveform ?? [];
  const voiceComposeBars = useMemo(
    () => buildInlineComposeWaveform(voiceComposeSource, voiceRecorder.recording),
    [voiceComposeSource, voiceRecorder.recording],
  );
  const voiceComposeDurationMs = voiceRecorder.recording ? voiceRecorder.recordingMs : compose.voice?.durationMs ?? 0;

  return (
    <>
    <section className={styles.page}>
        {selectedTarget == null ? (
          <div
            key={`list-${panelAnimEpoch}`}
            className={`${styles.messagesListView} ${
              panelTransition === "fromLeft" ? styles.messagesListAnimFromLeft : ""
            }`}
          >
            <header className={styles.messagesListHeader}>
              <div className={styles.messagesSearchHeader}>
                <TabSearchInput
                  placeholder="Поиск чатов и сообщений"
                  value={searchQuery}
                  onChange={setSearchQuery}
                  classNames={{
                    wrap: styles.messagesSearchWrap,
                    box: styles.messagesSearchBox,
                    icon: styles.messagesSearchIcon,
                    input: styles.messagesSearchInput,
                    actionButton: styles.messagesSearchSendBtn,
                    actionButtonShown: styles.messagesSearchSendBtnShown,
                    actionButtonHidden: styles.messagesSearchSendBtnHidden,
                  }}
                />
              </div>

              <div className={styles.messagesDropdowns}>
                <div className={styles.messagesDropdownWrap}>
                  <button
                    type="button"
                    className={`${styles.messagesDropdownBtn} ${dropdownSortOpen ? styles.messagesDropdownBtnOpen : ""}`}
                    onClick={() => {
                      setDropdownSortOpen((value) => !value);
                      setDropdownFilterOpen(false);
                      setCreateMenuOpen(false);
                    }}
                  >
                    <span className={styles.messagesDropdownBtnLeft} aria-hidden={true} />
                    <span className={styles.messagesDropdownBtnText}>{sortBy === "recent" ? "Последние" : "Непрочитанные"}</span>
                    <span className={styles.messagesDropdownBtnRight}>
                      <svg className={styles.messagesDropdownIcon} width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M7 10l5 5 5-5z" />
                      </svg>
                    </span>
                  </button>
                  {dropdownSortOpen ? (
                    <div className={styles.messagesDropdownMenu}>
                      <button
                        type="button"
                        className={`${styles.messagesDropdownItem} ${sortBy === "recent" ? styles.messagesDropdownItemActive : ""}`}
                        onClick={() => {
                          setSortBy("recent");
                          setDropdownSortOpen(false);
                        }}
                      >
                        Последние
                      </button>
                      <button
                        type="button"
                        className={`${styles.messagesDropdownItem} ${sortBy === "unread" ? styles.messagesDropdownItemActive : ""}`}
                        onClick={() => {
                          setSortBy("unread");
                          setDropdownSortOpen(false);
                        }}
                      >
                        Непрочитанные
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className={styles.messagesDropdownWrap}>
                  <button
                    type="button"
                    className={`${styles.messagesDropdownBtn} ${dropdownFilterOpen ? styles.messagesDropdownBtnOpen : ""}`}
                    onClick={() => {
                      setDropdownFilterOpen((value) => !value);
                      setDropdownSortOpen(false);
                      setCreateMenuOpen(false);
                    }}
                  >
                    <span className={styles.messagesDropdownBtnLeft} aria-hidden={true} />
                    <span className={styles.messagesDropdownBtnText}>
                      {filterFrom === "all"
                        ? "От всех"
                        : filterFrom === "people"
                          ? "От людей"
                          : filterFrom === "communities"
                            ? "От сообществ"
                            : "От разработчика"}
                    </span>
                    <span className={styles.messagesDropdownBtnRight}>
                      <svg className={styles.messagesDropdownIcon} width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M7 10l5 5 5-5z" />
                      </svg>
                    </span>
                  </button>
                  {dropdownFilterOpen ? (
                    <div className={styles.messagesDropdownMenu}>
                      <button
                        type="button"
                        className={`${styles.messagesDropdownItem} ${filterFrom === "all" ? styles.messagesDropdownItemActive : ""}`}
                        onClick={() => {
                          setFilterFrom("all");
                          setDropdownFilterOpen(false);
                        }}
                      >
                        От всех
                      </button>
                      <button
                        type="button"
                        className={`${styles.messagesDropdownItem} ${filterFrom === "people" ? styles.messagesDropdownItemActive : ""}`}
                        onClick={() => {
                          setFilterFrom("people");
                          setDropdownFilterOpen(false);
                        }}
                      >
                        От людей
                      </button>
                      <button
                        type="button"
                        className={`${styles.messagesDropdownItem} ${filterFrom === "communities" ? styles.messagesDropdownItemActive : ""}`}
                        onClick={() => {
                          setFilterFrom("communities");
                          setDropdownFilterOpen(false);
                        }}
                      >
                        От сообществ
                      </button>
                      <button
                        type="button"
                        className={`${styles.messagesDropdownItem} ${filterFrom === "dev" ? styles.messagesDropdownItemActive : ""}`}
                        onClick={() => {
                          setFilterFrom("dev");
                          setDropdownFilterOpen(false);
                        }}
                      >
                        От разработчика
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Горизонталь 7: папки ← Архив ← «+»@88 */}
              <MessagesChatFolders
                folders={visibleFolders}
                activeFolder={activeFolder}
                onSelect={setListFolder}
                onDeleteFolder={(folderId) => {
                  void removeChatListFolder(folderId);
                  if (listFolder === folderId) setListFolder("all");
                }}
              />
              <div className={styles.messagesCreateWrap}>
                <button
                  type="button"
                  className={styles.messagesCreateBtn}
                  aria-label="Создать папку или группу"
                  aria-expanded={createMenuOpen}
                  onClick={() => {
                    setDropdownSortOpen(false);
                    setDropdownFilterOpen(false);
                    setCreateMenuOpen((open) => !open);
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                  </svg>
                </button>
                {createMenuOpen ? (
                  <div className={styles.messagesCreateMenu} role="menu">
                    <button
                      type="button"
                      className={styles.messagesCreateMenuItem}
                      role="menuitem"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        if (!canCreateFolder) {
                          window.alert(
                            "Можно показать не больше четырёх иконок, включая Архив. Удалите папку или уберите чаты из архива.",
                          );
                          return;
                        }
                        setCreateFolderOpen(true);
                      }}
                    >
                      <span className={styles.messagesCreateMenuItemIcon}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                          <path d="M3 7a2 2 0 012-2h5l2 2h9a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                        </svg>
                      </span>
                      Папка
                    </button>
                    <button
                      type="button"
                      className={styles.messagesCreateMenuItem}
                      role="menuitem"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        setCreateGroupOpen(true);
                      }}
                    >
                      <span className={styles.messagesCreateMenuItemIcon}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                        </svg>
                      </span>
                      Группа
                    </button>
                  </div>
                ) : null}
              </div>
            </header>

            {listError ? <p className={styles.messagesError}>{listError}</p> : null}
            {listLoading && conversations.length === 0 && mergedListItems.length === 0 ? (
              <ul className={styles.messagesConversationList} aria-hidden>
                {Array.from({ length: 6 }, (_, i) => (
                  <li key={i} className={styles.messagesConversationSkeletonRow}>
                    <div className={styles.messagesConversationSkeletonAvatar} />
                    <div className={styles.messagesConversationSkeletonBody}>
                      <div className={styles.messagesConversationSkeletonLinePrimary} />
                      <div className={styles.messagesConversationSkeletonLineSecondary} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            {!listLoading && mergedListItems.length === 0 ? (
              <p className={emptyHintStyles.hint}>
                {activeFolder === "archived"
                  ? archivedConversationsCount === 0
                    ? "Пока нет переписок в архиве. Перенесите чат в архив из меню ⋮."
                    : "Ничего не найдено. Измените запрос в поиске."
                  : activeFolder !== "all"
                    ? "В этой папке пока нет чатов."
                    : conversations.length === 0 && groupChats.length === 0
                      ? "Пока нет переписок. Найдите человека во вкладке «Люди»."
                      : activeConversationsCount === 0 && groupChats.length === 0
                        ? "Все чаты в архиве. Откройте Архив справа от фильтров."
                        : "Ничего не найдено. Измените запрос в поиске."}
              </p>
            ) : null}

            {mergedListItems.length > 0 ? (
              <ul className={styles.messagesConversationList}>
                {mergedListItems.map((item) => {
                  const row =
                    item.kind === "groupChat"
                      ? {
                          key: `groupChat:${item.group.conversationUuid}`,
                          kind: "group" as const,
                          title: item.group.title,
                          handle: null as string | null,
                          preview: item.group.lastMessagePreview?.trim() || "Нет сообщений",
                          unreadCount: item.group.unreadCount,
                          online: false,
                          mute: null as ReturnType<typeof getPeerMute>,
                          archived: isConversationArchived(
                            item.group.conversationUuid,
                            archivedByConversation,
                          ),
                          avatar: {
                            displayName: item.group.title,
                            username: undefined as string | undefined,
                            communityName: item.group.title,
                            seed: item.group.conversationUuid,
                          },
                          onOpen: () => openGroupChat(item.group.conversationUuid),
                          onPrefetch: undefined as (() => void) | undefined,
                          more: {
                            conversationMenuKind: "group" as const,
                            accessibility: {
                              dialog: `Меню группы «${item.group.title}»`,
                              triggerOpen: `Действия — ${item.group.title}`,
                              triggerClose: "Закрыть меню группы",
                            },
                          },
                          peerUuid: null as string | null,
                          groupUuid: item.group.conversationUuid as string | null,
                        }
                      : (() => {
                          const chat = item.conversation;
                          const title = chat.otherDisplayName || chat.otherUsername;
                          return {
                            key: chat.otherUserUuid,
                            kind: "dm" as const,
                            title,
                            handle: chat.otherUsername.replace(/^@+/, "") || "…",
                            preview: conversationPreview(
                              chat,
                              listPreviewDecryptedByPeer,
                              listPreviewDecryptFailByPeer,
                            ),
                            unreadCount: chat.unreadCount,
                            online: chat.otherUserIsOnline,
                            mute: getPeerMute(chat.otherUserUuid),
                            archived: isPeerArchived(chat.otherUserUuid),
                            avatar: {
                              displayName: title,
                              username: chat.otherUsername,
                              communityName: undefined as string | undefined,
                              seed: chat.otherUserUuid,
                            },
                            onOpen: () => switchChat(chat),
                            onPrefetch: () => prefetchPeerThread(chat.otherUserUuid),
                            more: {
                              conversationMenuKind: "dm" as const,
                              accessibility: {
                                dialog: `Меню чата с ${title}`,
                                triggerOpen: `Действия — ${title}`,
                                triggerClose: "Закрыть меню чата",
                              },
                            },
                            peerUuid: chat.otherUserUuid,
                            groupUuid: null as string | null,
                          };
                        })();
                  const peerUuid = row.peerUuid;
                  const groupUuid = row.groupUuid;

                  return (
                    <li key={row.key} className={styles.messagesConversationRow}>
                      <button
                        type="button"
                        className={`${styles.messagesConversationItem} flora-type-15`}
                        onClick={row.onOpen}
                        onPointerEnter={row.onPrefetch}
                        onFocus={row.onPrefetch}
                      >
                        <div className={styles.messagesConversationAvatarWrap}>
                          <FloraAvatar
                            plain
                            size={45}
                            displayName={row.avatar.displayName}
                            username={row.avatar.username}
                            communityName={row.avatar.communityName}
                            seed={row.avatar.seed}
                          />
                          {row.kind === "dm" ? (
                            <span
                              className={`${styles.messagesChatHeaderOnlineBadge}${
                                row.online ? ` ${styles.messagesChatHeaderOnlineBadgeVisible}` : ""
                              }`}
                              title={row.online ? "В сети" : undefined}
                              aria-hidden
                            />
                          ) : null}
                        </div>
                        <div className={styles.messagesConversationBody}>
                          <div className={styles.messagesConversationTitleRow}>
                            <span className={styles.messagesConversationName}>{row.title}</span>
                            {row.handle !== null ? (
                              <span className={styles.messagesConversationHandleGroup}>
                                <span className={styles.messagesConversationHandle}>
                                  @{row.handle}
                                </span>
                                {row.mute ? (
                                  <MessagesConversationMuteIndicator
                                    mute={row.mute}
                                    onExpired={() => {
                                      if (peerUuid) clearLocalTemporaryMute(peerUuid);
                                    }}
                                  />
                                ) : null}
                              </span>
                            ) : null}
                          </div>
                          <span className={styles.messagesConversationPreview}>{row.preview}</span>
                        </div>
                      </button>
                      <div className={styles.messagesConversationActions}>
                        {row.unreadCount > 0 ? (
                          <span className={styles.messagesConversationUnread}>
                            {row.unreadCount > 99 ? "99+" : row.unreadCount}
                          </span>
                        ) : null}
                      </div>
                      <PostMoreMenuRect
                        variant="conversation"
                        conversationMenuKind={row.more.conversationMenuKind}
                        wrapClassName={`${styles.messagesConversationMoreWrap} ${postMoreMenuStyles.wrapGlyphNudgeLeft1} ${postMoreMenuStyles.wrapBackdropNudgeLeft1}`}
                        buttonClassName={styles.messagesConversationMoreBtn}
                        conversationIsMuted={row.mute !== null}
                        conversationIsArchived={row.archived}
                        onConversationMuteForever={
                          peerUuid ? () => setPeerMutedForever(peerUuid) : undefined
                        }
                        onConversationMuteTemporary={
                          peerUuid ? () => setPeerMutedTemporary(peerUuid) : undefined
                        }
                        onConversationUnmute={
                          peerUuid ? () => clearPeerMuted(peerUuid) : undefined
                        }
                        onConversationArchive={
                          groupUuid
                            ? () => archiveGroup(groupUuid)
                            : peerUuid
                              ? () => archivePeer(peerUuid)
                              : undefined
                        }
                        onConversationUnarchive={
                          groupUuid
                            ? () => unarchiveGroup(groupUuid)
                            : peerUuid
                              ? () => unarchivePeer(peerUuid)
                              : undefined
                        }
                        folderOptions={row.kind === "dm" ? folderPickOptions : []}
                        onAddToFolder={
                          peerUuid
                            ? (folderId) => {
                                void addPeerToChatListFolder(folderId, peerUuid);
                              }
                            : undefined
                        }
                        onDeleteConversation={
                          groupUuid
                            ? () => openDeleteGroupModal(groupUuid, row.title)
                            : peerUuid
                              ? () => openDeleteConversationModal(peerUuid, row.title)
                              : undefined
                        }
                        accessibility={row.more.accessibility}
                      />
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : openChatHeader ? (
          <div className={styles.messagesChatSplit}>
            <div
              key={`${selectedOtherUuid ?? selectedGroupUuid}-${panelAnimEpoch}`}
              className={`${styles.messagesChatPanelInner} ${chatOpenAnimClassName}`}
            >
              <div
                ref={messagesChatViewRef}
                className={styles.messagesChatView}
                style={messagesChatViewStyle}
                data-messages-chat-view=""
                data-group-chat={openChatHeader.kind === "group" ? "" : undefined}
              >
              <div className={styles.messagesChatTop}>
              <header className={styles.messagesChatHeader}>
                <button
                  type="button"
                  className={styles.messagesChatHeaderBackBtn}
                  onClick={closeChat}
                  title="Назад"
                  aria-label="Назад к списку чатов"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
                <div className={styles.messagesChatHeaderAvatarWrap}>
                  {openChatHeader.avatar.kind === "group" ? (
                    <FloraAvatar
                      plain
                      size={45}
                      displayName={openChatHeader.avatar.title}
                      communityName={openChatHeader.avatar.title}
                      seed={openChatHeader.avatar.seed}
                    />
                  ) : (
                    <FloraAvatar
                      plain
                      size={45}
                      displayName={openChatHeader.avatar.displayName}
                      username={openChatHeader.avatar.username}
                      seed={openChatHeader.avatar.seed}
                    />
                  )}
                  {openChatHeader.kind === "dm" ? (
                    <span
                      className={`${styles.messagesChatHeaderOnlineBadge}${
                        openChatHeader.online
                          ? ` ${styles.messagesChatHeaderOnlineBadgeVisible}`
                          : ""
                      }`}
                      title={openChatHeader.online ? "В сети" : undefined}
                      aria-hidden
                    />
                  ) : null}
                </div>
                <div className={styles.messagesChatHeaderInfo}>
                  {openChatHeader.kind === "group" ? (
                    <button
                      type="button"
                      className={styles.messagesChatHeaderNameLink}
                      onClick={() => {
                        setGroupMembersError(null);
                        setGroupMembersOpen(true);
                      }}
                      aria-label={`${openChatHeader.title}, ${openChatHeader.status?.text ?? ""}`}
                    >
                      <div className={styles.messagesChatHeaderNameRow}>
                        <span className={styles.messagesChatHeaderName}>
                          {openChatHeader.title}
                        </span>
                      </div>
                    </button>
                  ) : openChatHeader.profileHref ? (
                    <Link
                      href={openChatHeader.profileHref}
                      className={styles.messagesChatHeaderNameLink}
                    >
                      <div className={styles.messagesChatHeaderNameRow}>
                        <span className={styles.messagesChatHeaderName}>
                          {openChatHeader.title}
                        </span>
                        {openChatHeader.handle ? (
                          <span className={styles.messagesChatHeaderHandle}>
                            @{openChatHeader.handle}
                          </span>
                        ) : null}
                      </div>
                    </Link>
                  ) : null}
                  {openChatHeader.status ? (
                    <div
                      className={styles.messagesChatHeaderStatus}
                      role="status"
                      aria-label={openChatHeader.status.aria}
                    >
                      {openChatHeader.status.kind === "typing" ? (
                        <>
                          Печатает
                          <span className={styles.messagesChatHeaderTypingDots} aria-hidden="true">
                            <span>.</span>
                            <span>.</span>
                            <span>.</span>
                          </span>
                        </>
                      ) : (
                        openChatHeader.status.text
                      )}
                    </div>
                  ) : null}
                </div>
                <PostMoreMenuRect
                  variant="chat"
                  chatMenuKind={openChatHeader.more.chatMenuKind}
                  wrapClassName={styles.messagesChatHeaderMoreWrap}
                  buttonClassName={styles.messagesChatHeaderMoreBtn}
                  conversationIsMuted={openChatHeader.more.conversationIsMuted}
                  conversationIsArchived={
                    openChatHeader.kind === "group" && selectedGroupUuid
                      ? isConversationArchived(selectedGroupUuid, archivedByConversation)
                      : openChatHeader.kind === "dm" && selectedOtherUuid
                        ? isPeerArchived(selectedOtherUuid)
                        : false
                  }
                  onConversationMuteForever={
                    openChatHeader.kind === "dm" && selectedOtherUuid
                      ? () => setPeerMutedForever(selectedOtherUuid)
                      : undefined
                  }
                  onConversationMuteTemporary={
                    openChatHeader.kind === "dm" && selectedOtherUuid
                      ? () => setPeerMutedTemporary(selectedOtherUuid)
                      : undefined
                  }
                  onConversationUnmute={
                    openChatHeader.kind === "dm" && selectedOtherUuid
                      ? () => clearPeerMuted(selectedOtherUuid)
                      : undefined
                  }
                  onConversationArchive={
                    openChatHeader.kind === "group" && selectedGroupUuid
                      ? () => archiveGroup(selectedGroupUuid)
                      : openChatHeader.kind === "dm" && selectedOtherUuid
                        ? () => archivePeer(selectedOtherUuid)
                        : undefined
                  }
                  onConversationUnarchive={
                    openChatHeader.kind === "group" && selectedGroupUuid
                      ? () => unarchiveGroup(selectedGroupUuid)
                      : openChatHeader.kind === "dm" && selectedOtherUuid
                        ? () => unarchivePeer(selectedOtherUuid)
                        : undefined
                  }
                  onChatSafetyNumber={
                    openChatHeader.kind === "dm" && selectedOtherUuid
                      ? () =>
                          openSafetyNumberModal(
                            selectedOtherUuid,
                            openChatHeader.title,
                          )
                      : undefined
                  }
                  onDeleteConversation={
                    openChatHeader.kind === "group" && selectedGroupUuid
                      ? () => openDeleteGroupModal(selectedGroupUuid, openChatHeader.title)
                      : openChatHeader.kind === "dm" && selectedOtherUuid
                        ? () =>
                            openDeleteConversationModal(
                              selectedOtherUuid,
                              openChatHeader.title,
                            )
                        : undefined
                  }
                  accessibility={openChatHeader.more.accessibility}
                />
              </header>

              {threadError ? <p className={styles.messagesError}>{threadError}</p> : null}
              {openChatHeader.kind === "dm" && fscpStatus === "transient_error" ? (
                // Транзиент/сбой окружения — баннер, НЕ сырая строка ошибки ядра и НЕ модалка пароля
                // (см. план fscp_restore_reliability, дефект 5): дашборд уже тихо повторяет резолв.
                <p className={styles.messagesError}>
                  {fscpFailure === "transient"
                    ? "Проверяем ключи шифрования — временные проблемы с сетью, повторяем попытку автоматически."
                    : "Ключи шифрования временно недоступны из-за ошибки окружения на этом устройстве."}
                </p>
              ) : (openChatHeader.kind === "dm" || openChatHeader.kind === "group") &&
                fscpBootstrapError ? (
                <p className={styles.messagesError}>
                  FSCP: {fscpBootstrapError}
                  {fscpStatusNeedsPassword(fscpStatus) ? (
                    <>
                      {" — "}
                      <button
                        type="button"
                        onClick={openFscpUnlock}
                        style={{
                          padding: 0,
                          border: 0,
                          background: "none",
                          font: "inherit",
                          color: "inherit",
                          textDecoration: "underline",
                          cursor: "pointer",
                        }}
                      >
                        ввести пароль
                      </button>
                    </>
                  ) : null}
                </p>
              ) : null}
              {threadLoading ? <p className={emptyHintStyles.hint}>Загрузка…</p> : null}
            </div>

            <div className={styles.messagesChatScrollShell}>
              <div className={styles.messagesChatMessages}>
                <div
                  ref={scrollMessagesRef}
                  className={styles.messagesChatMessagesScroll}
                  onScroll={handleMessagesScroll}
                >
                  <div ref={messagesInnerRef} className={styles.messagesChatMessagesInner}>
                    <div className={styles.messagesChatMessagesSpacer} aria-hidden />
                  {threadRenderItems.map((item) => {
                    const renderMessageBubble = (message: MessageThreadItemDto) => {
                      const content = displayMessageContent(message);
                      const voiceOnly =
                        content !== "decrypting" && content !== "failed" && isVoiceOnlyPayload(content);
                      const voiceBlock = voiceOnly ? getVoiceBlockFromPayload(content) : null;
                      const payloadBlocks =
                        content !== "decrypting" && content !== "failed" ? content.blocks : null;
                      const mediaBlocks =
                        !voiceOnly && payloadBlocks
                          ? payloadBlocks.filter(
                              (block): block is FscpImageBlock | FscpVideoBlock =>
                                block.kind === "image" || block.kind === "video",
                            )
                          : [];
                      const captionBlocks =
                        payloadBlocks?.filter((block) => block.kind !== "image" && block.kind !== "video") ??
                        [];
                      const photoBubble = mediaBlocks.length > 0;
                      const imageMediaBlocks = mediaBlocks.filter(
                        (block): block is FscpImageBlock => block.kind === "image",
                      );
                      const photoCollage = imageMediaBlocks.length >= 2;
                      const videoMediaBlocks = mediaBlocks.filter(
                        (block): block is FscpVideoBlock => block.kind === "video",
                      );
                      const photoOnly = photoBubble && captionBlocks.length === 0;
                      const lastPayloadBlock = payloadBlocks
                        ? payloadBlocks[payloadBlocks.length - 1]
                        : undefined;
                      const lastCaptionBlock = captionBlocks[captionBlocks.length - 1];
                      const inlineTime =
                        content === "decrypting" || content === "failed"
                          ? true
                          : voiceOnly
                            ? false
                            : photoBubble
                              ? !photoOnly && lastCaptionBlock?.kind === "text"
                              : lastPayloadBlock?.kind === "text";
                      const replyQuote =
                        content !== "decrypting" && content !== "failed" && content.replyTo ? (
                          <MessageBubbleReplyQuote reply={content.replyTo} isFromMe={message.isFromMe} />
                        ) : null;
                      const deliveryState = messageDeliveryState(message);
                      const timeMeta = deliveryState ? <MessageReadReceipt state={deliveryState} /> : null;
                      const timeInlineReservePx = deliveryState ? MESSAGE_RECEIPT_INLINE_RESERVE_PX : 0;
                      const canReply = message.sendStatus !== "sending";
                      return (
                        <MessageBubbleAnchor
                          anchorClassName={styles.messagesBubbleAnchor}
                          isFromMe={message.isFromMe}
                          wrapClassName={styles.messagesBubbleMoreWrap}
                          buttonClassName={styles.messagesBubbleMoreBtn}
                          onCopy={() => void copyMessageContent(content)}
                          onReply={canReply ? () => beginReplyToMessage(message) : undefined}
                          onDelete={
                            message.isFromMe && !isGroupChatOpen
                              ? () => void handleDeleteMessage(message)
                              : undefined
                          }
                        >
                          <div
                            className={`${styles.messagesBubble} ${message.isFromMe ? styles.messagesBubbleMe : styles.messagesBubbleThem} ${voiceOnly ? styles.messagesBubbleVoiceOnly : ""} ${photoBubble ? styles.messagesBubblePhoto : ""} ${photoCollage ? styles.messagesBubblePhotoCollage : ""} ${inlineTime ? styles.messagesBubbleInlineTime : ""}`}
                          >
                            {content === "failed" ? (
                              <>
                                {replyQuote}
                                <p className={styles.messagesBubbleText}>
                                  {FSCP_DECRYPT_FAIL_LABEL}
                                  <MessageBubbleTime
                                    message={message}
                                    className={styles.messagesBubbleTimeFloat}
                                  />
                                </p>
                              </>
                            ) : content === "decrypting" ? null : voiceOnly && voiceBlock ? (
                              <>
                                {replyQuote}
                                <VoiceMessageCard
                                  durationMs={voiceBlock.durationMs}
                                  waveform={voiceBlock.waveform}
                                  voiceBlock={
                                    isDemoPlaintextWire(message.encryptedForMe) ? undefined : voiceBlock
                                  }
                                  localBlob={localVoiceBlobForAsset(voiceBlock.assetUuid)}
                                  timeSlot={<MessageBubbleTime message={message} />}
                                />
                              </>
                            ) : photoBubble ? (
                              <>
                                {replyQuote}
                                <div className={styles.messagesBubblePhotoMedia}>
                                  {imageMediaBlocks.length >= 2 ? (
                                    <MessageImageCollage
                                      blocks={imageMediaBlocks}
                                      getLocalBlob={devGetImageBlob}
                                      skipDecrypt={isDemoPlaintextWire(message.encryptedForMe)}
                                    />
                                  ) : imageMediaBlocks.length === 1 ? (
                                    <ImageMessageCard
                                      key={`${message.messageUuid}-${imageMediaBlocks[0]!.assetUuid}`}
                                      imageBlock={
                                        isDemoPlaintextWire(message.encryptedForMe)
                                          ? undefined
                                          : imageMediaBlocks[0]
                                      }
                                      localBlob={devGetImageBlob(imageMediaBlocks[0]!.assetUuid)}
                                    />
                                  ) : null}
                                  {videoMediaBlocks.map((block) => (
                                    <VideoMessageCard
                                      key={`${message.messageUuid}-${block.assetUuid}`}
                                      videoBlock={
                                        isDemoPlaintextWire(message.encryptedForMe) ? undefined : block
                                      }
                                      localBlob={devGetVideoBlob(block.assetUuid)}
                                    />
                                  ))}
                                  {photoOnly ? (
                                    <MessageBubbleTime
                                      message={message}
                                      className={styles.messagesBubblePhotoTime}
                                    />
                                  ) : null}
                                </div>
                                {!photoOnly ? (
                                  <div className={styles.messagesBubblePhotoCaption}>
                                    {captionBlocks.map((block, index) =>
                                      block.kind === "text" ? (
                                        <MessageBubbleText
                                          key={`${message.messageUuid}-${index}`}
                                          body={block.body}
                                          inlineTime={inlineTime && index === captionBlocks.length - 1}
                                          timeLabel={formatChatTime(message.createdAt)}
                                          timeMeta={timeMeta}
                                          timeInlineReservePx={timeInlineReservePx}
                                        />
                                      ) : block.kind === "voice" ? (
                                        <VoiceMessageCard
                                          key={`${message.messageUuid}-${block.assetUuid}`}
                                          durationMs={block.durationMs}
                                          waveform={block.waveform}
                                          voiceBlock={
                                            isDemoPlaintextWire(message.encryptedForMe)
                                              ? undefined
                                              : block
                                          }
                                          localBlob={localVoiceBlobForAsset(block.assetUuid)}
                                        />
                                      ) : null,
                                    )}
                                    {!inlineTime ? <MessageBubbleTime message={message} /> : null}
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              <div className={styles.messagesBubbleBlocks}>
                                {replyQuote}
                                {content.blocks.map((block, index) =>
                                  block.kind === "text" ? (
                                    <MessageBubbleText
                                      key={`${message.messageUuid}-${index}`}
                                      body={block.body}
                                      inlineTime={inlineTime && index === content.blocks.length - 1}
                                      timeLabel={formatChatTime(message.createdAt)}
                                      timeMeta={timeMeta}
                                      timeInlineReservePx={timeInlineReservePx}
                                    />
                                  ) : block.kind === "image" ? (
                                    <ImageMessageCard
                                      key={`${message.messageUuid}-${block.assetUuid}`}
                                      imageBlock={
                                        isDemoPlaintextWire(message.encryptedForMe) ? undefined : block
                                      }
                                      localBlob={devGetImageBlob(block.assetUuid)}
                                    />
                                  ) : block.kind === "video" ? (
                                    <VideoMessageCard
                                      key={`${message.messageUuid}-${block.assetUuid}`}
                                      videoBlock={
                                        isDemoPlaintextWire(message.encryptedForMe) ? undefined : block
                                      }
                                      localBlob={devGetVideoBlob(block.assetUuid)}
                                    />
                                  ) : block.kind === "voice" ? (
                                    <VoiceMessageCard
                                      key={`${message.messageUuid}-${block.assetUuid}`}
                                      durationMs={block.durationMs}
                                      waveform={block.waveform}
                                      voiceBlock={
                                        isDemoPlaintextWire(message.encryptedForMe) ? undefined : block
                                      }
                                      localBlob={localVoiceBlobForAsset(block.assetUuid)}
                                    />
                                  ) : (
                                    <MessageBubbleText
                                      key={`${message.messageUuid}-${index}`}
                                      body="Контент недоступен в этой версии приложения."
                                      inlineTime={inlineTime && index === content.blocks.length - 1}
                                      timeLabel={formatChatTime(message.createdAt)}
                                      timeMeta={timeMeta}
                                      timeInlineReservePx={timeInlineReservePx}
                                    />
                                  ),
                                )}
                              </div>
                            )}
                            {!photoBubble && !inlineTime && !voiceOnly ? (
                              <MessageBubbleTime message={message} />
                            ) : null}
                          </div>
                        </MessageBubbleAnchor>
                      );
                    };

                    if (item.kind === "own") {
                      return (
                        <div
                          key={item.message.messageUuid}
                          data-messages-bubble-wrap
                          className={`${styles.messagesBubbleWrap} ${styles.messagesBubbleWrapMe}`}
                        >
                          {renderMessageBubble(item.message)}
                        </div>
                      );
                    }

                    return (
                      <div
                        key={`peer-${item.groupKey}`}
                        data-messages-peer-group=""
                        className={styles.messagesPeerGroup}
                      >
                        <div className={styles.messagesPeerGroupBubbles}>
                          {item.messages.map((message) => (
                            <div
                              key={message.messageUuid}
                              data-messages-bubble-wrap
                              className={styles.messagesBubbleWrapInPeerGroup}
                            >
                              {renderMessageBubble(message)}
                            </div>
                          ))}
                        </div>
                        <div
                          key={`peer-avatar-${item.groupKey}`}
                          data-messages-peer-avatar=""
                          className={`${styles.messagesBubblePeerAvatar}${
                            selectedGroupChat ? ` ${styles.messagesBubblePeerAvatarFlora}` : ""
                          }`}
                          aria-hidden
                        >
                          {selectedGroupChat ? (
                            (() => {
                              const senderUuid =
                                item.messages[item.messages.length - 1]?.senderUserUuid?.trim() ||
                                item.messages[0]?.senderUserUuid?.trim() ||
                                "";
                              const member = findGroupMember(
                                selectedGroupChat.members,
                                senderUuid,
                              );
                              const label =
                                member?.displayName || member?.username || "Участник";
                              return (
                                <FloraAvatar
                                  plain
                                  size={45}
                                  displayName={label}
                                  username={member?.username || ""}
                                  avatarUuid={member?.avatarUuid}
                                  seed={senderUuid || label}
                                />
                              );
                            })()
                          ) : (
                            peerThreadAvatarLabel
                          )}
                        </div>
                      </div>
                    );
                  })}
                  </div>
                </div>
              </div>
              {peerBelowScrollCount > 0 ? (
                <button
                  type="button"
                  className={styles.messagesJumpToLatest}
                  onClick={jumpToLatestMessages}
                  aria-label={`Новые сообщения: ${peerBelowScrollCount}. Прокрутить вниз.`}
                >
                  <svg className={styles.messagesJumpToLatestIcon} width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
                  </svg>
                  <span className={styles.messagesJumpToLatestBadge}>
                    {peerBelowScrollCount > 99 ? "99+" : peerBelowScrollCount}
                  </span>
                </button>
              ) : null}
            </div>

            <div
              className={styles.messagesChatCompose}
            >
              <div ref={composeSurfaceRef} className={styles.messagesComposeStack}>
                {!voiceComposeActive && stickerPanelRendered ? (
                  <MessageStickerPanelAnchor>
                    <MessageStickerPanel
                      panelId="messages-sticker-panel"
                      active={stickerPanelOpen && !stickerPanelClosing}
                      closing={stickerPanelClosing}
                      layoutMotion={stickerPanelRendered && !stickerPanelClosing}
                      tab={stickerPanelTab}
                      tabTransition={stickerTabTransition}
                      tabAnimEpoch={stickerTabAnimEpoch}
                      onPickEmoji={insertComposeToken}
                      onSelectTab={selectStickerPanelTab}
                    />
                  </MessageStickerPanelAnchor>
                ) : null}
                <div
                  className={`${styles.messagesComposeField} ${
                    voiceComposeActive ? styles.messagesComposeFieldRecording : ""
                  }`}
                >
                  {!voiceComposeActive &&
                  (replyTo || compose.images.length > 0 || compose.videos.length > 0) ? (
                    <div className={styles.messagesComposeAttachStrips}>
                      {replyTo ? (
                        <MessageComposeReplyBar reply={replyTo} onDismiss={() => setReplyTo(null)} />
                      ) : null}
                      {compose.images.length > 0 || compose.videos.length > 0 ? (
                        <div className={styles.messagesComposeImageStrip}>
                          {compose.images.map((image, index) => (
                            <div key={image.id} className={styles.messagesComposeImageItem}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img className={styles.messagesComposeImageThumb} src={image.objectUrl} alt="" />
                              {image.preparing ? (
                                <span className={styles.messagesComposeVideoBadge}>Сжатие…</span>
                              ) : null}
                              <button
                                type="button"
                                className={styles.messagesComposeImageRemove}
                                aria-label="Убрать фото"
                                onClick={() => compose.removeImageAt(index)}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          {compose.videos.map((video, index) => (
                            <div key={video.id} className={styles.messagesComposeImageItem}>
                              <video
                                className={styles.messagesComposeVideoThumb}
                                src={video.objectUrl}
                                muted
                                playsInline
                                preload="metadata"
                              />
                              {video.preparing ? (
                                <span className={styles.messagesComposeVideoBadge}>Сжатие…</span>
                              ) : (
                                <span className={styles.messagesComposeVideoBadge}>
                                  {formatVoiceComposeDuration(video.durationMs)}
                                </span>
                              )}
                              <button
                                type="button"
                                className={styles.messagesComposeVideoDownload}
                                aria-label="Скачать видео"
                                onClick={() =>
                                  triggerVideoBlobDownload(
                                    video.objectUrl,
                                    video.contentType,
                                    "flora-video-draft",
                                  )
                                }
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                className={styles.messagesComposeImageRemove}
                                aria-label="Убрать видео"
                                onClick={() => compose.removeVideoAt(index)}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className={styles.messagesComposeFieldShell}>
                    <div className={styles.messagesComposeFieldBody}>
                  <div className={styles.messagesComposeRow}>
                {voiceComposeActive ? (
                  <button
                    type="button"
                    className={styles.messagesComposeTrash}
                    aria-label="Удалить голосовое"
                    disabled={sending || threadLoading}
                    onClick={discardVoiceRecording}
                  >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path d="M4 7h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                      <path
                        d="M6 7l1 14h10l1-14M9 7V4h6v3"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                ) : (
                  <MessageComposeAttachMenu
                    wrapClassName={styles.messagesComposeAttachWrap}
                    buttonClassName={styles.messagesComposePlus}
                    panelPlacement="above"
                    disabled={composeMediaDisabled}
                    closeNonce={composeAttachMenuCloseNonce}
                    onPick={handleAttachPick}
                    onOpenChange={(open) => {
                      setComposeAttachMenuOpen(open);
                      if (open && stickerPanelRendered) requestCloseStickerPanel();
                    }}
                  />
                )}

                {voiceComposeActive ? (
                  <div className={styles.messagesVoiceInlineCard} role="status" aria-label="Запись голосового сообщения">
                    <span className={styles.messagesVoiceInlineDuration}>
                      {formatVoiceComposeDuration(voiceComposeDurationMs)}
                    </span>
                    <div className={styles.messagesVoiceInlineWave} aria-hidden>
                      {voiceComposeBars.map((level, index) => (
                        <span key={index} style={{ height: `${Math.round(5 + level * 22)}px` }} />
                      ))}
                    </div>
                    {voiceRecorder.error ? <span className={styles.messagesVoiceInlineError}>{voiceRecorder.error}</span> : null}
                  </div>
                ) : (
                  <div className={styles.messagesComposeBlocks}>
                    <textarea
                      ref={composeInputRef}
                      className={styles.messagesComposeInput}
                      placeholder="Сообщение…"
                      rows={1}
                      value={compose.text}
                      disabled={sending || threadLoading}
                      onChange={(event) => compose.setText(event.target.value)}
                      onPaste={(event) => {
                        const pasted = extractPastedMessageImages(event.clipboardData);
                        if (pasted.length === 0) return;
                        event.preventDefault();
                        const result = compose.mergeImages(pasted);
                        const err = messageImageAttachError(result);
                        if (err) setThreadError(err);
                        else setThreadError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void handleSend();
                        }
                      }}
                    />
                  </div>
                )}

                {!voiceComposeActive ? (
                  <>
                    <button
                      type="button"
                      className={styles.messagesStickerButton}
                      aria-label="Стикеры и эмодзи"
                      aria-controls="messages-sticker-panel"
                      aria-expanded={stickerPanelOpen}
                      disabled={composeStickersDisabled}
                      onClick={toggleStickerPanel}
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path
                          d="M12 20.2a8.2 8.2 0 1 0 0-16.4 8.2 8.2 0 0 0 0 16.4Z"
                          stroke="currentColor"
                          strokeWidth="1.55"
                        />
                        <path
                          d="M16.65 17.25c1.04-.24 1.98-.82 2.72-1.65-.42 2.02-1.85 3.46-3.92 3.9.63-.57 1.04-1.35 1.2-2.25Z"
                          stroke="currentColor"
                          strokeWidth="1.55"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path d="M9.25 11.15h.01M15.1 11.15h.01" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
                        <path d="M9.4 14.6c1.28 1.1 3.62 1.1 4.9 0" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
                      </svg>
                    </button>
                  </>
                ) : null}

                <div className={styles.messagesComposeActions}>
                  {voiceComposeActive ? (
                    <>
                      {voiceRecorder.recording ? (
                        <button
                          type="button"
                          className={styles.messagesComposeStop}
                          aria-label="Остановить запись"
                          disabled={sending || threadLoading}
                          onClick={stopVoiceRecording}
                        >
                          <span aria-hidden />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={styles.messagesComposeSend}
                        aria-label={voiceRecorder.recording ? "Остановить и отправить голосовое" : "Отправить голосовое"}
                        disabled={sending || threadLoading || (!voiceRecorder.recording && !compose.voice)}
                        onClick={sendVoiceCompose}
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path
                            d="M4 20 20 12 4 4l3 8-3 8Z"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M7 12h13"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </>
                  ) : !compose.canSend ? (
                    <button
                      type="button"
                      className={styles.messagesComposeMic}
                      aria-label="Голосовое сообщение"
                      onClick={startVoiceRecording}
                      disabled={composeMediaDisabled}
                    >
                      <MusicTrackKindIcon kind="mic" className={styles.messagesComposeMicIcon} size={22} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.messagesComposeSend}
                      aria-label="Отправить"
                      disabled={sending || threadLoading}
                      onClick={() => void handleSend()}
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path
                          d="M4 20 20 12 4 4l3 8-3 8Z"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M7 12h13"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
                  </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {/* Мини-список справа от чата — временно скрыт.
            При включении: map(mergedListItems.slice(0, 16)):
            - kind "dm" → switchChat(conversation), online badge, preview decrypt
            - kind "groupChat" → openGroupChat(conversationUuid), group avatar, lastMessagePreview
            Active row: selectedTarget match on kind + id.
        <aside
              className={`${styles.messagesChatRail} ${chatOpenAnimClassName}`}
              aria-label="Другие диалоги"
            >
              ...
            </aside>
        */}
          </div>
        ) : null}
      </section>
      <MessagesDeleteConversationModal
        open={pendingDeleteConversation != null}
        closing={deleteConversationModalClosing}
        busy={deleteConversationBusy}
        error={deleteConversationError}
        peerDisplayName={pendingDeleteConversation?.displayName ?? ""}
        targetKind={pendingDeleteConversation?.kind === "group" ? "group" : "dm"}
        onClose={closeDeleteConversationModal}
        onConfirm={confirmDeleteConversation}
      />
      <MessagesSafetyNumberModal
        open={pendingSafetyNumber != null}
        closing={safetyNumberClosing}
        peerDisplayName={pendingSafetyNumber?.displayName ?? ""}
        viewerUserUuid={me?.userUuid?.trim() ?? ""}
        peerUserUuid={pendingSafetyNumber?.peerUuid ?? ""}
        selfSigningPrivateKey={fscpMaterial?.signingPrivateKey ?? null}
        peerIdentityPublicKeyBase64Url={peerIdentityPublicKeyB64}
        onClose={closeSafetyNumberModal}
      />

      <CreateChatFolderDialog
        open={createFolderOpen}
        conversations={conversations}
        onClose={() => setCreateFolderOpen(false)}
        onCreate={(result) => {
          void (async () => {
            const created = await createChatListFolder({
              label: result.name,
              icon: result.icon,
              memberPeerUuids: result.memberUserUuids,
            });
            if (created) {
              setListFolder(created.id);
              return;
            }
            window.alert(
              "Не удалось создать папку. Возможно, заняты все слоты иконок — удалите папку или очистите архив.",
            );
          })();
        }}
      />

      <CreateGroupDialog
        open={createGroupOpen}
        conversations={conversations}
        onClose={() => setCreateGroupOpen(false)}
        onCreate={async (result) => {
          if (!groupChatMe) {
            window.alert("Войдите в аккаунт, чтобы создать группу.");
            return false;
          }
          try {
            const { ok, missing } = await filterMembersWithE2eKeys(result.memberUserUuids);
            if (missing.length > 0) {
              window.alert(
                "У некоторых участников нет ключа шифрования. Пусть они один раз войдут в аккаунт.",
              );
              return false;
            }
            if (ok.length === 0) {
              window.alert("Выберите хотя бы одного участника с ключом шифрования.");
              return false;
            }
            const created = await apiCreateGroup({
              title: result.title,
              memberUserUuids: ok,
            });
            await refreshGroups();
            openGroupChat(created.conversationUuid);
            return true;
          } catch (e) {
            window.alert(
              e instanceof ApiRequestError
                ? e.message
                : "Не удалось создать группу. Проверьте участников и ключи.",
            );
            return false;
          }
        }}
      />

      {selectedGroupChat ? (
        <GroupMembersPanel
          open={groupMembersOpen}
          title={selectedGroupChat.title}
          members={selectedGroupChat.members}
          meUserUuid={me?.userUuid ?? ""}
          isCreator={
            (me?.userUuid?.trim().toLowerCase() ?? "") !== "" &&
            selectedGroupChat.createdByUserUuid.trim().toLowerCase() ===
              (me?.userUuid?.trim().toLowerCase() ?? "")
          }
          addCandidates={conversations}
          busy={groupMembersBusy}
          error={groupMembersError}
          onClose={() => {
            if (groupMembersBusy) return;
            setGroupMembersError(null);
            setGroupMembersOpen(false);
          }}
          onSaveTitle={handleGroupSaveTitle}
          onRemoveMember={handleGroupRemoveMember}
          onAddMember={handleGroupAddMember}
        />
      ) : null}
    </>
  );
}

function MessagesPageContent() {
  const { isClient, hasToken } = useProtectedPage();
  if (!isClient || !hasToken) {
    return <div className={styles.page} />;
  }
  return <MessagesChatInner />;
}

export default function MessagesPage() {
  return (
    <Suspense fallback={<div className={styles.page} />}>
      <MessagesPageContent />
    </Suspense>
  );
}
