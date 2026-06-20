"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { fscpStatusNeedsPassword, useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { PostMoreMenuRect } from "@/app/_shared/PostMoreMenuRect";
import postMoreMenuStyles from "@/app/_shared/PostMoreMenu.module.css";
// import { PostMoreMenu } from "@/app/_shared/PostMoreMenu";
import { TabSearchInput } from "@/app/_shared/TabSearchInput";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { ApiRequestError, isDevLocalOfflineSession } from "@/lib/auth";
import { fromBase64Flexible } from "@/lib/fscp/base64url";
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
  apiUploadMessageImageAsset,
  apiUploadMessageVideoAsset,
  apiUploadMessageVoiceAsset,
  type ConversationListItemDto,
  type MessageThreadItemDto,
} from "@/lib/socialApi";
import { extractPastedMessageImages, messageImageAttachError } from "@/lib/messageImages";
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
} from "@/lib/devLocalDemoData";
import { formatWasOnlineRu } from "@/lib/lastSeenRu";
import { ImageMessageCard } from "./ImageMessageCard";
import { MessageImageCollage } from "./MessageImageCollage";
import { MessageBubbleAnchor } from "./MessageBubbleMoreMenu";
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
import { MessagesListScopeNav, type MessagesChatListScope } from "./MessagesListScopeNav";
import { useMessagesListPreviewDecrypt } from "./useMessagesListPreviewDecrypt";
import { usePreloadConversationThreads } from "./usePreloadConversationThreads";
import { usePreloadThreadMessageMedia } from "./usePreloadThreadMessageMedia";
import { floraDurationMs } from "@/lib/floraMotion";

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
  const { me, fscpMaterial, fscpBootstrapLoading, fscpBootstrapError, fscpStatus, openFscpUnlock } =
    useCurrentUser();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationListItemDto[]>(() => {
    const cached = conversationsCache.peek();
    return cached ? cached.items.map(toConversationDto) : [];
  });
  const [listLoading, setListLoading] = useState(() => conversationsCache.peek() === null);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedOtherUuid, setSelectedOtherUuid] = useState<string | null>(null);
  /** Снимок строки списка при открытии чата (заголовок не пропадает, если список ещё перезагружается). */
  const [selectedPeer, setSelectedPeer] = useState<ConversationListItemDto | null>(null);
  const [threadMessages, setThreadMessages] = useState<MessageThreadItemDto[]>([]);
  /** Нормализованный me.userUuid на момент последней успешной загрузки ленты; без этого не расшифровываем (иначе кэш чужой ленты + новый JWT). */
  const [threadFetchedForViewerNorm, setThreadFetchedForViewerNorm] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /* Идёт клиентское сжатие прикрепляемого видео (большие файлы перекодируются в реальном времени). */

  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "unread">("recent");
  const [chatListScope, setChatListScope] = useState<MessagesChatListScope>("all");
  /** Архив по UUID собеседника (пока только UI, без API). */
  const [archivedByPeer, setArchivedByPeer] = useState<Record<string, true>>({});
  const [filterFrom, setFilterFrom] = useState<"all" | "people" | "communities" | "dev">("all");
  const [dropdownSortOpen, setDropdownSortOpen] = useState(false);
  const [dropdownFilterOpen, setDropdownFilterOpen] = useState(false);
  /** Мут по UUID собеседника (пока только UI, без API). */
  const [mutedPeers, setMutedPeers] = useState<Record<string, ConversationMuteEntry>>({});
  const compose = useMessageComposeDraft();
  const [decryptedById, setDecryptedById] = useState<Record<string, FscpMessagePlaintext>>({});
  const [decryptFailById, setDecryptFailById] = useState<Record<string, string>>({});
  const decryptingRef = useRef<Set<string>>(new Set());
  const conversationsRef = useRef<ConversationListItemDto[]>([]);
  /** Пока идёт POST+GET после отправки — подмешиваем в ответ листинга, если messageUuid ещё нет. */
  const pendingOutgoingRef = useRef<MessageThreadItemDto | null>(null);
  const threadFetchContextRef = useRef<{ peer: string | null; viewerNorm: string }>({ peer: null, viewerNorm: "" });
  const scrollMessagesRef = useRef<HTMLDivElement | null>(null);
  /** После успешной загрузки ленты — отслеживаем дифф для новых сообщений собеседника. */
  const scrollTrackingReadyRef = useRef(false);
  const prevSeenMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingScrollSmoothAfterSendRef = useRef(false);
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

  const clearPeerMuted = useCallback((peerUuid: string) => {
    setMutedPeers((prev) => {
      if (!(peerUuid in prev)) return prev;
      const next = { ...prev };
      delete next[peerUuid];
      return next;
    });
  }, []);

  const setPeerMutedForever = useCallback((peerUuid: string) => {
    setMutedPeers((prev) => ({ ...prev, [peerUuid]: { kind: "forever" } }));
  }, []);

  const setPeerMutedTemporary = useCallback((peerUuid: string) => {
    setMutedPeers((prev) => ({
      ...prev,
      [peerUuid]: { kind: "until", untilMs: Date.now() + CONVERSATION_MUTE_DEFAULT_DURATION_MS },
    }));
  }, []);

  const getPeerMute = useCallback(
    (peerUuid: string): ConversationMuteEntry | null => {
      const entry = mutedPeers[peerUuid];
      if (!entry || !isConversationMuteActive(entry)) return null;
      return entry;
    },
    [mutedPeers],
  );

  const isPeerArchived = useCallback((peerUuid: string) => peerUuid in archivedByPeer, [archivedByPeer]);

  const archivePeer = useCallback((peerUuid: string) => {
    setArchivedByPeer((prev) => ({ ...prev, [peerUuid]: true }));
  }, []);

  const unarchivePeer = useCallback((peerUuid: string) => {
    setArchivedByPeer((prev) => {
      if (!(peerUuid in prev)) return prev;
      const next = { ...prev };
      delete next[peerUuid];
      return next;
    });
  }, []);

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
    if (!selectedOtherUuid) return;
    applyPanelTransition("fromLeft");
    setSelectedOtherUuid(null);
    setSelectedPeer(null);
  }, [applyPanelTransition, selectedOtherUuid]);

  const switchChat = useCallback(
    (chat: ConversationListItemDto, fromMainList: boolean) => {
      if (chat.otherUserUuid === selectedOtherUuid) return;

      if (!selectedOtherUuid) {
        applyPanelTransition("fromRight");
      } else {
        const prevIdx = conversationsRef.current.findIndex(
          (c) => c.otherUserUuid === selectedOtherUuid,
        );
        const nextIdx = conversationsRef.current.findIndex(
          (c) => c.otherUserUuid === chat.otherUserUuid,
        );
        if (prevIdx !== -1 && nextIdx !== -1) {
          applyPanelTransition(nextIdx > prevIdx ? "fromBottom" : "fromTop");
        } else {
          applyPanelTransition("fromRight");
        }
      }

      // alignRailScrollFromMainListRef.current = fromMainList;
      setSelectedPeer(chat);
      setSelectedOtherUuid(chat.otherUserUuid);
    },
    [applyPanelTransition, selectedOtherUuid],
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

  useEffect(() => {
    if (!isClient) return;
    const onMessagesChanged = (event: Event) => {
      void refreshConversationList();
      const detail = (event as CustomEvent<MessagesChangedDetail | undefined>).detail;
      const incomingConversationUuid = detail?.conversationUuid?.trim().toLowerCase();
      const viewerUuid = me?.userUuid?.trim() ?? "";
      const peer = selectedOtherUuid?.trim() ?? "";
      if (!incomingConversationUuid || !viewerUuid || !peer) return;
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
    };
    window.addEventListener(MESSAGES_UNREAD_CHANGED_EVENT, onMessagesChanged);
    return () => window.removeEventListener(MESSAGES_UNREAD_CHANGED_EVENT, onMessagesChanged);
  }, [isClient, me?.userUuid, refreshConversationList, selectedOtherUuid]);

  const viewerUuid = me?.userUuid?.trim() ?? "";
  const viewerNorm = viewerUuid.toLowerCase();
  const { listPreviewDecryptedByPeer, listPreviewDecryptFailByPeer } = useMessagesListPreviewDecrypt(
    conversations,
    fscpMaterial,
    viewerUuid,
  );
  const { prefetchPeerThread } = usePreloadConversationThreads(viewerNorm, conversations, {
    viewerUuid,
    fscpMaterial,
  });
  usePreloadThreadMessageMedia(decryptedById);

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
    pendingScrollSmoothAfterSendRef.current = false;
    setPeerBelowScrollCount(0);
    composeResetRef.current();
    voiceRecorder.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- сброс черновика только при смене чата/зрителя
  }, [selectedOtherUuid, me?.userUuid]);

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
    setSelectedOtherUuid(withUuid);
    router.replace("/messages", { scroll: false });
  }, [isClient, hasToken, router, searchParams, applyPanelTransition]);

  useEffect(() => {
    if (!isClient || !hasToken || !selectedOtherUuid) {
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
  }, [isClient, hasToken, selectedOtherUuid, me?.userUuid]);

  const NEAR_BOTTOM_PX = 72;

  const jumpToLatestMessages = useCallback(() => {
    const el = scrollMessagesRef.current;
    if (!el) return;
    setPeerBelowScrollCount(0);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const el = scrollMessagesRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) {
      setPeerBelowScrollCount(0);
    }
  }, []);

  /** Первый показ ленты — вниз; новые от собеседника не у края — счётчик; своя отправка — плавный скролл вниз. */
  useEffect(() => {
    if (!selectedOtherUuid) return;
    if (threadLoading) {
      scrollTrackingReadyRef.current = false;
      return;
    }
    const el = scrollMessagesRef.current;
    if (!el || threadMessages.length === 0) {
      if (threadMessages.length === 0) scrollTrackingReadyRef.current = false;
      return;
    }

    if (!scrollTrackingReadyRef.current) {
      scrollTrackingReadyRef.current = true;
      prevSeenMessageIdsRef.current = new Set(threadMessages.map((m) => m.messageUuid));
      queueMicrotask(() =>
        requestAnimationFrame(() => {
          const box = scrollMessagesRef.current;
          if (box) box.scrollTo({ top: box.scrollHeight, behavior: "auto" });
        })
      );
      return;
    }

    const prev = prevSeenMessageIdsRef.current;
    const newly = threadMessages.filter((m) => !prev.has(m.messageUuid));
    prevSeenMessageIdsRef.current = new Set(threadMessages.map((m) => m.messageUuid));
    if (newly.length === 0) return;

    const peerNew = newly.filter((m) => !m.isFromMe).length;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = gap < NEAR_BOTTOM_PX;

    if (peerNew > 0) {
      if (nearBottom) {
        setPeerBelowScrollCount(0);
        queueMicrotask(() =>
          requestAnimationFrame(() => {
            const box = scrollMessagesRef.current;
            if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
          })
        );
      } else {
        setPeerBelowScrollCount((c) => Math.min(99, c + peerNew));
      }
      return;
    }

    if (pendingScrollSmoothAfterSendRef.current && newly.some((m) => m.isFromMe)) {
      pendingScrollSmoothAfterSendRef.current = false;
      queueMicrotask(() =>
        requestAnimationFrame(() => {
          const box = scrollMessagesRef.current;
          if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
        })
      );
    }
  }, [threadMessages, threadLoading, selectedOtherUuid]);

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

  const filteredConversations = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    let list = [...conversations];

    if (chatListScope === "all") {
      list = list.filter((item) => !isPeerArchived(item.otherUserUuid));
    } else {
      list = list.filter((item) => isPeerArchived(item.otherUserUuid));
    }

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
    chatListScope,
    conversations,
    filterFrom,
    isPeerArchived,
    listPreviewDecryptFailByPeer,
    listPreviewDecryptedByPeer,
    searchQuery,
    sortBy,
  ]);

  const activeConversationsCount = useMemo(
    () => conversations.filter((item) => !isPeerArchived(item.otherUserUuid)).length,
    [conversations, isPeerArchived],
  );

  const archivedConversationsCount = useMemo(
    () => conversations.filter((item) => isPeerArchived(item.otherUserUuid)).length,
    [conversations, isPeerArchived],
  );

  const chatHeaderPeer = useMemo((): ConversationListItemDto | null => {
    if (!selectedOtherUuid) return null;
    const fromList = conversations.find((c) => c.otherUserUuid === selectedOtherUuid);
    if (fromList) return fromList;
    if (selectedPeer?.otherUserUuid === selectedOtherUuid) return selectedPeer;
    return {
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
    };
  }, [conversations, selectedOtherUuid, selectedPeer]);

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
    if (chatHeaderPeer.otherUserIsOnline) {
      return { text: "В сети", aria: "В сети" as const };
    }
    const was = formatWasOnlineRu(chatHeaderPeer.otherUserLastSeenAt, new Date());
    if (was) return { text: was, aria: was };
    return { text: "Не в сети", aria: "Не в сети" as const };
  }, [chatHeaderPeer, presenceClock]);

  // const railChatsSource = useMemo(
  //   (): ConversationListItemDto[] => conversations.slice(0, 16),
  //   [conversations],
  // );

  // const railInteractive = conversations.length > 0;

  // const railScrollRef = useRef<HTMLDivElement>(null);

  // useLayoutEffect(() => {
  //   const scrollEl = railScrollRef.current;
  //   if (!scrollEl || !selectedOtherUuid) return;

  //   if (!alignRailScrollFromMainListRef.current) {
  //     return;
  //   }

  //   alignRailScrollFromMainListRef.current = false;

  //   const idx = railChatsSource.findIndex((c) => c.otherUserUuid === selectedOtherUuid);
  //   if (idx < 0) {
  //     scrollEl.scrollTop = 0;
  //     return;
  //   }

  //   const n = railChatsSource.length;
  //   const ul = scrollEl.querySelector("ul");
  //   const row = ul?.querySelectorAll<HTMLLIElement>(":scope > li")[idx];
  //   if (!row) {
  //     return;
  //   }

  //   const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

  //   if (idx <= 2) {
  //     scrollEl.scrollTop = 0;
  //   } else if (idx >= n - 3) {
  //     scrollEl.scrollTop = maxScroll;
  //   } else {
  //     const rowTopInContent =
  //       row.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
  //     const rowH = row.offsetHeight;
  //     const desired = rowTopInContent - (scrollEl.clientHeight - rowH) / 2;
  //     scrollEl.scrollTop = Math.max(0, Math.min(desired, maxScroll));
  //   }
  // }, [selectedOtherUuid, railChatsSource]);

  const displayMessageContent = useCallback(
    (m: MessageThreadItemDto): FscpMessagePlaintext | "decrypting" | "failed" => {
      if (decryptedById[m.messageUuid]) return decryptedById[m.messageUuid];
      const enc = m.encryptedForMe?.trim();
      if (enc) {
        const demoPlain = parseDemoPlaintextWire(enc);
        if (demoPlain) return demoPlain;
        if (decryptFailById[m.messageUuid]) return "failed";
        if (isFscpWirePayload(enc)) return "decrypting";
      }
      if (m.content?.trim()) return messagePlaintextFromText(m.content);
      return messagePlaintextFromText("—");
    },
    [decryptedById, decryptFailById]
  );

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

  useEffect(() => {
    setReplyTo(null);
  }, [selectedOtherUuid]);

  const handleAttachPick = useCallback(
    (kind: ComposeAttachKind, files: FileList) => {
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
      if (kind !== "video") return;
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
    [compose],
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
    pendingScrollSmoothAfterSendRef.current = true;
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
        const realRow: MessageThreadItemDto = {
          messageUuid: sent.messageUuid,
          content: null,
          encryptedForMe: devPlaintextWire(finalPayload),
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
          setThreadMessages((prev) => replaceOptimisticOutgoing(prev, optimisticMessageUuid, realRow));
          setThreadFetchedForViewerNorm(viewerNorm);
        }
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

      const sent = await msgSendMessageToUser(myUuid, peerUuid, wire, {
        voiceAssetUuids: [uploaded.voiceAssetUuid],
      }, plaintextToPreview(finalPayload));

      const realRow: MessageThreadItemDto = {
        messageUuid: sent.messageUuid,
        content: null,
        encryptedForMe: wire,
        createdAt: sent.createdAt,
        isFromMe: true,
        isRead: false,
      };

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
          setThreadMessages(replaceOptimisticOutgoing(rows, optimisticMessageUuid, realRow));
          setThreadFetchedForViewerNorm(viewerNorm);
        } catch {
          setThreadMessages((prev) => replaceOptimisticOutgoing(prev, optimisticMessageUuid, realRow));
          setThreadFetchedForViewerNorm(viewerNorm);
        } finally {
          pendingOutgoingRef.current = null;
          clearPendingVoiceBlob(uploaded.voiceAssetUuid);
        }
      } else {
        clearPendingVoiceBlob(uploaded.voiceAssetUuid);
      }

      await refreshConversationList();
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
    compose,
    fscpBootstrapError,
    fscpBootstrapLoading,
    fscpMaterial,
    me?.userUuid,
    refreshConversationList,
    replyTo,
    selectedOtherUuid,
  ]);

  const handleSend = useCallback(async () => {
    if (!selectedOtherUuid || !compose.canSend) return;
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
        pendingScrollSmoothAfterSendRef.current = true;
        setThreadMessages(devDemoGetThread(selectedOtherUuid));
        setThreadFetchedForViewerNorm(viewerNorm);
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
            const file = new File([prepared.blob], prepared.fileName, {
              type: prepared.contentType,
              lastModified: Date.now(),
            });
            const encrypted = await encryptVoiceBlob(file);
            const uploaded = await apiUploadMessageImageAsset({
              toUserUuid: selectedOtherUuid,
              encryptedBlob: encrypted.encryptedBlob,
              contentType: prepared.contentType,
            });
            imageAssetUuids.push(uploaded.imageAssetUuid);
            blocks.push({
              kind: "image",
              assetUuid: uploaded.imageAssetUuid,
              contentType: prepared.contentType,
              encryption: {
                algorithm: "aes-gcm",
                keyBase64Url: encrypted.keyBase64Url,
                nonceBase64Url: encrypted.nonceBase64Url,
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
      pendingScrollSmoothAfterSendRef.current = true;
      setThreadMessages((prev) => mergePendingOutgoing(prev, optimisticRow));

      const sent = await msgSendMessageToUser(myUuid, selectedOtherUuid, wire, {
        imageAssetUuids,
        videoAssetUuids,
      }, plaintextToPreview(outgoingPayload));
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

      try {
        invalidateConversationThread(viewerNorm, selectedOtherUuid);
        let rows = (await getConversationThread(viewerNorm, selectedOtherUuid)).items.map(toMessageDto);
        if (!rows.some((r) => r.messageUuid === sent.messageUuid)) {
          await new Promise((r) => setTimeout(r, 450));
          invalidateConversationThread(viewerNorm, selectedOtherUuid);
          rows = (await getConversationThread(viewerNorm, selectedOtherUuid)).items.map(toMessageDto);
        }
        const next = mergePendingOutgoing(rows, pendingRow);
        pendingScrollSmoothAfterSendRef.current = true;
        setThreadMessages(next);
        setThreadFetchedForViewerNorm(viewerNorm);
      } catch {
        pendingScrollSmoothAfterSendRef.current = true;
        setThreadMessages((prev) =>
          optimisticMessageUuid
            ? replaceOptimisticOutgoing(prev, optimisticMessageUuid, pendingRow)
            : mergePendingOutgoing(prev, pendingRow),
        );
        setThreadFetchedForViewerNorm(viewerNorm);
      } finally {
        pendingOutgoingRef.current = null;
      }
      await refreshConversationList();
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
    compose,
    fscpBootstrapError,
    fscpBootstrapLoading,
    fscpMaterial,
    me?.userUuid,
    refreshConversationList,
    replyTo,
    selectedOtherUuid,
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

  const voiceComposeActive = compose.mode === "voice" || voiceRecorder.recording || compose.voice !== null;
  const voiceComposeSource = voiceRecorder.recording ? voiceRecorder.liveWaveform : compose.voice?.waveform ?? [];
  const voiceComposeBars = useMemo(
    () => buildInlineComposeWaveform(voiceComposeSource, voiceRecorder.recording),
    [voiceComposeSource, voiceRecorder.recording],
  );
  const voiceComposeDurationMs = voiceRecorder.recording ? voiceRecorder.recordingMs : compose.voice?.durationMs ?? 0;

  return (
    <section className={styles.page}>
        {selectedOtherUuid == null ? (
          <div
            key={`list-${panelAnimEpoch}`}
            className={`${styles.messagesListView} ${
              panelTransition === "fromLeft" ? styles.messagesListAnimFromLeft : ""
            }`}
          >
            <header className={styles.messagesListHeader}>
              <MessagesListScopeNav scope={chatListScope} onScopeChange={setChatListScope} />
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
            </header>

            {listError ? <p className={styles.messagesError}>{listError}</p> : null}
            {listLoading && conversations.length === 0 ? (
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

            {!listLoading && filteredConversations.length === 0 ? (
              <p className={emptyHintStyles.hint}>
                {chatListScope === "archived"
                  ? archivedConversationsCount === 0
                    ? "Пока нет переписок в архиве. Перенесите чат в архив из меню ⋮."
                    : "Ничего не найдено. Измените запрос в поиске."
                  : conversations.length === 0
                    ? "Пока нет переписок. Найдите человека во вкладке «Люди»."
                    : activeConversationsCount === 0
                      ? "Все чаты в архиве. Откройте архив в шапке списка."
                      : "Ничего не найдено. Измените запрос в поиске."}
              </p>
            ) : null}

            {!listLoading && filteredConversations.length > 0 ? (
              <ul className={styles.messagesConversationList}>
                {filteredConversations.map((chat) => {
                  const chatDisplayName = chat.otherDisplayName || chat.otherUsername;
                  const peerMute = getPeerMute(chat.otherUserUuid);
                  const peerArchived = isPeerArchived(chat.otherUserUuid);
                  return (
                  <li key={chat.otherUserUuid} className={styles.messagesConversationRow}>
                    <button
                      type="button"
                      className={`${styles.messagesConversationItem} flora-type-15`}
                      onClick={() => switchChat(chat, true)}
                      onPointerEnter={() => prefetchPeerThread(chat.otherUserUuid)}
                      onFocus={() => prefetchPeerThread(chat.otherUserUuid)}
                    >
                      <div className={styles.messagesConversationAvatarWrap}>
                        <div className={styles.messagesConversationAvatar}>
                          {avatarLetters(chatDisplayName)}
                        </div>
                        {chat.otherUserIsOnline ? (
                          <span className={styles.messagesChatHeaderOnlineBadge} title="В сети" aria-hidden />
                        ) : null}
                      </div>
                      <div className={styles.messagesConversationBody}>
                        <div className={styles.messagesConversationTitleRow}>
                          <span className={styles.messagesConversationName}>
                            {chatDisplayName}
                          </span>
                          <span className={styles.messagesConversationHandleGroup}>
                            <span className={styles.messagesConversationHandle}>
                              @{chat.otherUsername.replace(/^@+/, "") || "…"}
                            </span>
                            {peerMute ? (
                              <MessagesConversationMuteIndicator
                                mute={peerMute}
                                onExpired={() => clearPeerMuted(chat.otherUserUuid)}
                              />
                            ) : null}
                          </span>
                        </div>
                        <span className={styles.messagesConversationPreview}>
                          {conversationPreview(chat, listPreviewDecryptedByPeer, listPreviewDecryptFailByPeer)}
                        </span>
                      </div>
                    </button>
                    <div className={styles.messagesConversationActions}>
                      {chat.unreadCount > 0 ? (
                        <span className={styles.messagesConversationUnread}>
                          {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
                        </span>
                      ) : null}
                    </div>
                    <PostMoreMenuRect
                      variant="conversation"
                      wrapClassName={`${styles.messagesConversationMoreWrap} ${postMoreMenuStyles.wrapGlyphNudgeLeft1} ${postMoreMenuStyles.wrapBackdropNudgeLeft1}`}
                      buttonClassName={styles.messagesConversationMoreBtn}
                      conversationIsMuted={peerMute !== null}
                      conversationIsArchived={peerArchived}
                      onConversationMuteForever={() => setPeerMutedForever(chat.otherUserUuid)}
                      onConversationMuteTemporary={() => setPeerMutedTemporary(chat.otherUserUuid)}
                      onConversationUnmute={() => clearPeerMuted(chat.otherUserUuid)}
                      onConversationArchive={() => archivePeer(chat.otherUserUuid)}
                      onConversationUnarchive={() => unarchivePeer(chat.otherUserUuid)}
                      accessibility={{
                        dialog: `Меню чата с ${chatDisplayName}`,
                        triggerOpen: `Действия — ${chatDisplayName}`,
                        triggerClose: `Закрыть меню чата`,
                      }}
                    />
                  </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : chatHeaderPeer ? (
          <div className={styles.messagesChatSplit}>
            <div
              key={`${selectedOtherUuid}-${panelAnimEpoch}`}
              className={`${styles.messagesChatPanelInner} ${chatOpenAnimClassName}`}
            >
              <div
                className={styles.messagesChatView}
                style={messagesChatViewStyle}
                data-messages-chat-view=""
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
                  <div className={styles.messagesChatHeaderAvatar}>
                    {avatarLetters(chatHeaderPeer.otherDisplayName || chatHeaderPeer.otherUsername)}
                  </div>
                  {chatHeaderPeer.otherUserIsOnline ? (
                    <span className={styles.messagesChatHeaderOnlineBadge} title="В сети" aria-hidden />
                  ) : null}
                </div>
                <div className={styles.messagesChatHeaderInfo}>
                  <Link
                    href={`/profile/${encodeURIComponent(chatHeaderPeer.otherUsername.replace(/^@+/, "") || chatHeaderPeer.otherUserUuid)}`}
                    className={styles.messagesChatHeaderNameLink}
                  >
                    <div className={styles.messagesChatHeaderNameRow}>
                      <span className={styles.messagesChatHeaderName}>
                        {chatHeaderPeer.otherDisplayName || chatHeaderPeer.otherUsername || "Пользователь"}
                      </span>
                      <span className={styles.messagesChatHeaderHandle}>
                        @{chatHeaderPeer.otherUsername.replace(/^@+/, "") || "…"}
                      </span>
                    </div>
                  </Link>
                  {chatHeaderPresenceLine ? (
                    <div
                      className={styles.messagesChatHeaderStatus}
                      role="status"
                      aria-label={chatHeaderPresenceLine.aria}
                    >
                      {chatHeaderPresenceLine.text}
                    </div>
                  ) : null}
                </div>
                {selectedOtherUuid ? (
                  <PostMoreMenuRect
                    variant="chat"
                    wrapClassName={styles.messagesChatHeaderMoreWrap}
                    buttonClassName={styles.messagesChatHeaderMoreBtn}
                    conversationIsMuted={getPeerMute(selectedOtherUuid) !== null}
                    onConversationMuteForever={() => setPeerMutedForever(selectedOtherUuid)}
                    onConversationMuteTemporary={() => setPeerMutedTemporary(selectedOtherUuid)}
                    onConversationUnmute={() => clearPeerMuted(selectedOtherUuid)}
                    accessibility={{
                      dialog: `Меню чата с ${chatHeaderPeer.otherDisplayName || chatHeaderPeer.otherUsername}`,
                      triggerOpen: `Действия — ${chatHeaderPeer.otherDisplayName || chatHeaderPeer.otherUsername}`,
                      triggerClose: "Закрыть меню чата",
                    }}
                  />
                ) : null}
              </header>

              {threadError ? <p className={styles.messagesError}>{threadError}</p> : null}
              {fscpBootstrapError ? (
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
                  {threadMessages.map((message, messageIndex) => {
                    const content = displayMessageContent(message);
                    const voiceOnly =
                      content !== "decrypting" && content !== "failed" && isVoiceOnlyPayload(content);
                    const voiceBlock = voiceOnly ? getVoiceBlockFromPayload(content) : null;
                    const payloadBlocks =
                      content !== "decrypting" && content !== "failed" ? content.blocks : null;
                    /* Пузырь с фото/видео (стиль TG): медиа сверху от края до края, подпись и время — под ним. */
                    const mediaBlocks =
                      !voiceOnly && payloadBlocks
                        ? payloadBlocks.filter(
                            (block): block is FscpImageBlock | FscpVideoBlock =>
                              block.kind === "image" || block.kind === "video"
                          )
                        : [];
                    const captionBlocks =
                      payloadBlocks?.filter((block) => block.kind !== "image" && block.kind !== "video") ?? [];
                    const photoBubble = mediaBlocks.length > 0;
                    const imageMediaBlocks = mediaBlocks.filter(
                      (block): block is FscpImageBlock => block.kind === "image",
                    );
                    const photoCollage = imageMediaBlocks.length >= 2;
                    const videoMediaBlocks = mediaBlocks.filter(
                      (block): block is FscpVideoBlock => block.kind === "video",
                    );
                    const photoOnly = photoBubble && captionBlocks.length === 0;
                    const lastPayloadBlock = payloadBlocks ? payloadBlocks[payloadBlocks.length - 1] : undefined;
                    const lastCaptionBlock = captionBlocks[captionBlocks.length - 1];
                    /* Время в строке текста (как в TG): только если последний блок пузыря — текст. */
                    const inlineTime =
                      content === "decrypting" || content === "failed"
                        ? true
                        : voiceOnly
                          ? false
                          : photoBubble
                            ? !photoOnly && lastCaptionBlock?.kind === "text"
                            : lastPayloadBlock?.kind === "text";
                    const nextMessage = threadMessages[messageIndex + 1];
                    const isPeerTail =
                      !message.isFromMe && (!nextMessage || nextMessage.isFromMe);
                    const peerAvatarLabel = avatarLetters(
                      chatHeaderPeer?.otherDisplayName || chatHeaderPeer?.otherUsername || "?"
                    );
                    const replyQuote =
                      content !== "decrypting" && content !== "failed" && content.replyTo ? (
                        <MessageBubbleReplyQuote reply={content.replyTo} isFromMe={message.isFromMe} />
                      ) : null;
                    const deliveryState = messageDeliveryState(message);
                    const timeMeta = deliveryState ? <MessageReadReceipt state={deliveryState} /> : null;
                    const timeInlineReservePx = deliveryState ? MESSAGE_RECEIPT_INLINE_RESERVE_PX : 0;
                    return (
                      <div
                        key={message.messageUuid}
                        data-messages-bubble-wrap
                        className={`${styles.messagesBubbleWrap} ${message.isFromMe ? styles.messagesBubbleWrapMe : ""} ${!message.isFromMe && !isPeerTail ? styles.messagesBubbleWrapPeerIndented : ""}`}
                      >
                        {!message.isFromMe && isPeerTail ? (
                          <div className={styles.messagesBubblePeerAvatar} aria-hidden>
                            {peerAvatarLabel}
                          </div>
                        ) : null}
                        <MessageBubbleAnchor
                          anchorClassName={styles.messagesBubbleAnchor}
                          isFromMe={message.isFromMe}
                          wrapClassName={styles.messagesBubbleMoreWrap}
                          buttonClassName={styles.messagesBubbleMoreBtn}
                          onCopy={() => void copyMessageContent(content)}
                          onReply={() => beginReplyToMessage(message)}
                          onDelete={
                            message.isFromMe ? () => void handleDeleteMessage(message) : undefined
                          }
                        >
                          <div
                            className={`${styles.messagesBubble} ${message.isFromMe ? styles.messagesBubbleMe : styles.messagesBubbleThem} ${voiceOnly ? styles.messagesBubbleVoiceOnly : ""} ${photoBubble ? styles.messagesBubblePhoto : ""} ${photoCollage ? styles.messagesBubblePhotoCollage : ""} ${inlineTime ? styles.messagesBubbleInlineTime : ""}`}
                          >
                          {content === "decrypting" || content === "failed" ? (
                            <>
                          {replyQuote}
                            <p className={styles.messagesBubbleText}>
                              {content === "decrypting" ? "Расшифровка…" : FSCP_DECRYPT_FAIL_LABEL}
                              <MessageBubbleTime message={message} className={styles.messagesBubbleTimeFloat} />
                            </p>
                            </>
                          ) : voiceOnly && voiceBlock ? (
                            <>
                          {replyQuote}
                            <VoiceMessageCard
                              durationMs={voiceBlock.durationMs}
                              waveform={voiceBlock.waveform}
                              voiceBlock={isDemoPlaintextWire(message.encryptedForMe) ? undefined : voiceBlock}
                              localBlob={localVoiceBlobForAsset(voiceBlock.assetUuid)}
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
                                      isDemoPlaintextWire(message.encryptedForMe) ? undefined : imageMediaBlocks[0]
                                    }
                                    localBlob={devGetImageBlob(imageMediaBlocks[0]!.assetUuid)}
                                  />
                                ) : null}
                                {videoMediaBlocks.map((block) => (
                                  <VideoMessageCard
                                    key={`${message.messageUuid}-${block.assetUuid}`}
                                    videoBlock={isDemoPlaintextWire(message.encryptedForMe) ? undefined : block}
                                    localBlob={devGetVideoBlob(block.assetUuid)}
                                  />
                                ))}
                                {photoOnly ? (
                                  <MessageBubbleTime message={message} className={styles.messagesBubblePhotoTime} />
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
                                        voiceBlock={isDemoPlaintextWire(message.encryptedForMe) ? undefined : block}
                                        localBlob={localVoiceBlobForAsset(block.assetUuid)}
                                      />
                                    ) : null
                                  )}
                                  {!inlineTime ? (
                                    <MessageBubbleTime message={message} />
                                  ) : null}
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
                                    imageBlock={isDemoPlaintextWire(message.encryptedForMe) ? undefined : block}
                                    localBlob={devGetImageBlob(block.assetUuid)}
                                  />
                                ) : block.kind === "video" ? (
                                  <VideoMessageCard
                                    key={`${message.messageUuid}-${block.assetUuid}`}
                                    videoBlock={isDemoPlaintextWire(message.encryptedForMe) ? undefined : block}
                                    localBlob={devGetVideoBlob(block.assetUuid)}
                                  />
                                ) : (
                                  <VoiceMessageCard
                                    key={`${message.messageUuid}-${block.assetUuid}`}
                                    durationMs={block.durationMs}
                                    waveform={block.waveform}
                                    voiceBlock={isDemoPlaintextWire(message.encryptedForMe) ? undefined : block}
                                    localBlob={localVoiceBlobForAsset(block.assetUuid)}
                                  />
                                )
                              )}
                            </div>
                          )}
                          {!photoBubble && !inlineTime ? (
                            <MessageBubbleTime message={message} />
                          ) : null}
                          </div>
                        </MessageBubbleAnchor>
                      </div>
                    );
                  })}
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
                    disabled={sending || threadLoading}
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
                      disabled={sending || threadLoading}
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
                      disabled={sending || threadLoading}
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
        <aside
              className={`${styles.messagesChatRail} ${chatOpenAnimClassName}`}
              aria-label="Другие диалоги"
            >
              <div className={styles.messagesChatRailViewport}>
                <div ref={railScrollRef} className={styles.messagesChatRailScroll}>
                  <div className={styles.messagesChatRailScrollInner}>
                  <ul className={styles.messagesChatRailList}>
                  {railChatsSource.map((mini) => (
                    <li key={mini.otherUserUuid} className={styles.messagesChatRailItem}>
                      <button
                        type="button"
                        className={`${styles.messagesChatRailRow} ${mini.otherUserUuid === selectedOtherUuid ? styles.messagesChatRailRowActive : ""}`}
                        disabled={!railInteractive}
                        title={
                          !railInteractive
                            ? "Войдите в аккаунт с чатами, чтобы переключаться"
                            : mini.unreadCount > 0
                              ? `${mini.otherDisplayName || mini.otherUsername} · ${mini.unreadCount} непрочит.`
                              : undefined
                        }
                        onClick={() => {
                          if (!railInteractive) return;
                          switchChat(mini, false);
                        }}
                      >
                        <div className={styles.messagesChatRailAvatarWrap}>
                          <div className={styles.messagesChatRailAvatar} aria-hidden>
                            {avatarLetters(mini.otherDisplayName || mini.otherUsername)}
                          </div>
                          {mini.otherUserIsOnline ? (
                            <span className={styles.messagesChatRailOnlineBadge} title="В сети" aria-hidden />
                          ) : null}
                        </div>
                        <div className={styles.messagesChatRailBody}>
                          <span className={styles.messagesChatRailName}>
                            {mini.otherDisplayName || mini.otherUsername}
                          </span>
                          <span className={styles.messagesChatRailPreview}>
                            {conversationPreview(mini, listPreviewDecryptedByPeer, listPreviewDecryptFailByPeer)}
                          </span>
                        </div>
                      </button>
                    </li>
                  ))}
                  </ul>
                  <div className={styles.messagesChatRailUnreadTrack} aria-hidden>
                    {railChatsSource.map((mini) => (
                      <div key={mini.otherUserUuid} className={styles.messagesChatRailUnreadRow}>
                        {mini.unreadCount > 0 ? (
                          <span className={styles.messagesChatRailUnreadBadge}>
                            {formatRailUnreadCount(mini.unreadCount)}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  </div>
                </div>
              </div>
            </aside>
        */}
          </div>
        ) : null}
      </section>
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
