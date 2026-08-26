import {
  apiGetConversations,
  apiGetMessages,
  apiMarkConversationRead,
  apiDeleteConversation,
  apiDeleteMessage,
  apiGetPushPreviewTargets,
  submitFrankingMessageReport,
} from "@flora/client-core/api";
import {
  apiGetUserE2ePublicKey,
  buildBlocksMessageWire,
  buildNotificationPreviewBundle,
  messageBlocksToPreview,
  sendTextMessage,
  type FscpImageBlock,
  type FscpMessageBlock,
  type FscpVoiceBlock,
  type NotificationPreviewKind,
} from "@flora/client-core/fscp";
import type {
  FrankingReportCategory,
  MsgConversationDto,
  MsgMessageDto,
} from "@flora/client-core/contracts";
import {
  apiPostTyping,
  apiPresenceHeartbeat,
  createTypingEmitter,
  type TypingEmitter,
} from "@flora/client-core/presence";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  Alert,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Pressable as GesturePressable } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardGestureArea, KeyboardEvents } from "react-native-keyboard-controller";
import Reanimated, {
  measure,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";
import {
  estimateBlocksInsertLiftPx,
  estimateRowInsertLiftPx,
  playChatListInsertLift,
} from "@/lib/chatListInsertLift";
import { maxTextBubbleInnerWidth } from "@/lib/messageBubbleLayout";
import { sliceThreadListToViewport } from "@/lib/threadListWindow";
import {
  buildThreadListItems,
  reuseThreadListItems,
  shouldHoldTrailingPeerAvatar,
  forEachThreadListMessage,
  trailingPeerRunMessages,
  type ThreadListItem,
} from "@/lib/threadMessageGroups";
import {
  ChatComposeField,
  type ChatComposeFieldHandle,
} from "@/components/messages/ChatComposeField";
import { ChatComposeReplyBar } from "@/components/messages/ChatComposeReplyBar";
import { ChatMessageBubble, type ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import { ChatPeerMessageRow } from "@/components/messages/ChatPeerMessageRow";
import { ChatMessageEmojiPanel } from "@/components/messages/ChatMessageEmojiPanel";
import { ChatGroupThreadHeader } from "@/components/messages/ChatGroupThreadHeader";
import { ChatMoreMenu } from "@/components/messages/ChatMoreMenu";
import { ChatReportMessageModal } from "@/components/messages/ChatReportMessageModal";
import { GroupMembersSheet } from "@/components/messages/GroupMembersSheet";
import {
  MessageBubbleMoreMenu,
  useOpenMessageMenuUuid,
  type BubbleAnchorRect,
} from "@/components/messages/MessageBubbleMoreMenu";
import {
  estimateMenuPanelHeight,
  lockMenuFit,
  MENU_ROW_HEIGHT_PX,
  shouldCloseMessageMenuOnListMotion,
} from "@/lib/messageBubbleMoreMenuLayout";
import { canReportMessage, frankingReportUserError } from "@/lib/messageReport";
import { ChatThreadHeader, type ChatPeerInfo } from "@/components/messages/ChatThreadHeader";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import { useChatListOverlayStore } from "@/lib/chatListOverlayStore";
import {
  canArchiveChatListPeer,
  countArchivedForFolderIcon,
  dmConversationUuidsOfArchivedPeers,
  isConversationArchived,
} from "@flora/client-core/messaging";
import {
  clearTemporaryMute,
  setTemporaryMute,
  useTemporaryMuteUntilByPeer,
} from "@/lib/conversationTemporaryMute";
import { applyMessagesTabBarHidden } from "@/lib/messagesTabBar";
import { setActiveMessageThread } from "@/lib/activeMessageThread";
import {
  markChatOpenStage,
  noteChatOpenCellRender,
  noteChatOpenLayoutWarm,
  noteChatOpenScreenRender,
} from "@/lib/chatOpenTrace";
import { warmThreadTextLayoutFromRows } from "@/lib/chatOpenLayoutWarm";
import { getCachedBodyMeasure } from "@/lib/messageTextMeasureCache";
import { warmMeasureRowInnerWidthPx } from "@/lib/messageTextMeasureWarm";
import { dismissMessagePushNotifications } from "@/lib/pushNotifications";
import { subscribeMessageRealtime } from "@/lib/realtimeSync";
import { requestTabBadgesRefresh } from "@/lib/useTabBadges";
import { chatListAnchorOffset, useChatComposeDock } from "@/lib/useChatComposeDock";
import {
  ChatScrollView,
} from "@/lib/ChatScrollView";
import {
  CHAT_AT_BOTTOM_THRESHOLD_PX,
  COMPOSE_BASELINE_FALLBACK_PX,
  emojiPanelChromePadding,
  keyboardStickyOffsets,
  resolveMessagesDockBottomInset,
} from "@/lib/messagesDockInsets";
import { ChatMessageBirthHost } from "@/components/messages/ChatMessageBirthHost";
import { floraNewUuid } from "@/lib/floraUuid";
import {
  markBirthPending,
  rememberClientMessageKey,
  resetBirthTracking,
  seedHydratedKeys,
} from "@/lib/messageBirthRegistry";
import {
  seedMessageImageUri,
  uploadPreparedMessageImage,
} from "@/lib/messageImageAssets";
import { copyTextToClipboard } from "@/lib/copyToClipboard";
import {
  applyMessagesPageToCaches,
  insertOptimisticOutgoingThreadMessage,
  markOutgoingMessagesReadInCache,
  removeOptimisticOutgoingThreadMessage,
  replaceOptimisticOutgoingThreadMessage,
} from "@/lib/messageThreadOutgoing";
import { subscribeRead } from "@/lib/readEvents";
import { replyDraftFromMessage, canReplyToMessage, type MessageReplyDraft } from "@/lib/messageReply";
import { uploadPreparedMessageVoice } from "@/lib/messageVoiceAssets";
import {
  clearPendingVoiceUri,
  registerPendingVoiceUri,
} from "@/lib/pendingVoiceOutgoing";
import { useMessageComposeImages } from "@/lib/useMessageComposeImages";
import { useMessageComposeVoice } from "@/lib/useMessageComposeVoice";
import { useVoiceRecorder } from "@/lib/useVoiceRecorder";
import { useGroupChatThread } from "@/lib/useGroupChatThread";
import { THREAD_REVEAL_WINDOW, useThreadMessageDecrypt } from "@/lib/useThreadMessageDecrypt";
import { messageThreadCache } from "@/stores/messageThreadCache";
import { useFscpStore } from "@/stores/fscpStore";
import { FscpUnlockSheet } from "@/components/fscp/FscpUnlockSheet";
import { useSessionStore } from "@/stores/sessionStore";
import { FRC_I_MIME } from "@flora/client-core/frc-i";

function previewKind(blocks: FscpMessageBlock[]): NotificationPreviewKind {
  const kinds = new Set(
    blocks.map((block) => (block.kind === "image" ? "photo" : block.kind)),
  );
  if (kinds.size !== 1) return "mixed";
  const only = [...kinds][0];
  return only === "text" || only === "photo" || only === "voice" || only === "video"
    ? only
    : "mixed";
}

async function buildEncryptedPushPreviews(params: {
  wire: string;
  recipientUserUuid: string;
  senderSigningPrivateKey: Uint8Array;
  blocks: FscpMessageBlock[];
}) {
  const targets = await apiGetPushPreviewTargets(params.recipientUserUuid).catch(() => []);
  if (targets.length === 0) return [];
  return buildNotificationPreviewBundle({
    messageWire: params.wire,
    recipientUserUuid: params.recipientUserUuid,
    senderSigningPrivateKey: params.senderSigningPrivateKey,
    preview: messageBlocksToPreview(params.blocks),
    kind: previewKind(params.blocks),
    targets,
  }).catch(() => []);
}

const EMPTY_MESSAGES: MsgMessageDto[] = [];

/** Сколько ждать расшифровки, прежде чем показать ленту как есть. */
const LIST_REVEAL_DEADLINE_MS = 1200;

/** Пауза между первым видимым кадром ленты и тихим сетевым догрузом. */
const POST_REVEAL_REFRESH_DELAY_MS = 250;

/** Запас к вьюпорту у окна первого коммита (оценки высот строк неточны). */
const LIST_WINDOW_BUFFER_PX = 260;
/** Доклейка хвоста истории за окном — после первого видимого кадра. */
const LIST_WINDOW_EXPAND_DELAY_MS = 150;
/**
 * Отпуск фоновых волн расшифровки. Раньше они отпускались ровно в кадр
 * показа — тяжёлый JS-коммит волны (монтаж десятков строк) совпадал с
 * моментом, когда пользователь начинает скроллить: лента появлялась и тут же
 * «замирала». Волны идут после доклейки окна.
 */
const WAVES_RELEASE_DELAY_MS = 400;

/**
 * Весь вьюпорт — одним коммитом FlashList. Дефолт v2 — прогрессивные волны по
 * 2 ячейки (6–8 коммитов на экран чата), из-за которых пузыри монтируются
 * пачками. Лента до onLoad скрыта, поэтому один тяжёлый коммит строго лучше
 * восьми лёгких: меньше суммарной работы и onLoad наступает раньше.
 */
const LIST_INITIAL_DRAW = { initialDrawBatchSize: 32 };

const PLACEHOLDER_AES = {
  algorithm: "aes-gcm" as const,
  keyBase64Url: "AAAAAAAAAAAAAAAAAAAAAA",
  nonceBase64Url: "AAAAAAAAAAAA",
};

function provisionalImageBlock(assetUuid: string, contentType: string): FscpImageBlock {
  return {
    kind: "image",
    assetUuid,
    contentType: contentType || FRC_I_MIME,
    encryption: PLACEHOLDER_AES,
  };
}

function provisionalVoiceBlock(params: {
  assetUuid: string;
  durationMs: number;
  waveform: number[];
  contentType: string;
}): FscpVoiceBlock {
  return {
    kind: "voice",
    assetUuid: params.assetUuid,
    durationMs: params.durationMs,
    waveform: params.waveform,
    contentType: params.contentType,
    encryption: PLACEHOLDER_AES,
  };
}

function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function parseBoolParam(value: string | string[] | undefined): boolean {
  const raw = routeParam(value);
  return raw === "1" || raw === "true";
}

/**
 * Coarse recycle pools: own/peer × voice/photo/text. Хвост run'а (строка с
 * аватаром) — тот же пул, что и остальные peer-строки: аватар — условный
 * ребёнок слота, а отдельный тип заставлял бы FlashList ремоунтить строку,
 * когда isGroupTail мигрирует при доклейке сообщений в run.
 */
const messageItemType = (item: ThreadListItem): string => {
  const message = item.message;
  const content = message.voiceBlock
    ? "voice"
    : message.imageBlocks.length > 0
      ? "photo"
      : "text";
  return item.kind === "own" ? content : `peer-${content}`;
};

function listItemKey(item: ThreadListItem): string {
  return item.message.clientMessageKey ?? item.message.messageUuid;
}

/**
 * Ширина текста строки окна показа — включая подписи медиа: у фото/голосового
 * своя колонка текста. Ровно та геометрия, которой греет offscreen-хост.
 */
function threadRowMeasureWidthPx(row: ThreadBubbleItem): number {
  return warmMeasureRowInnerWidthPx({
    isFromMe: row.isFromMe,
    media: row.voiceBlock ? "voice" : row.imageBlocks.length > 0 ? "photo" : undefined,
  });
}

/**
 * Сколько текстовых строк окна показа (включая подписи медиа) уже имеют
 * прогретый замер раскладки. Всё окно с кэш-хитом = первый кадр ленты
 * финальный: коррекций высот не будет, и гейт тишины сужается до кадра.
 */
function reportChatOpenLayoutWarm(rows: readonly ThreadBubbleItem[]): {
  hits: number;
  total: number;
} {
  let hits = 0;
  let total = 0;
  for (const row of rows.slice(-THREAD_REVEAL_WINDOW)) {
    if (!row.text?.trim()) continue;
    total += 1;
    if (getCachedBodyMeasure(row.text, threadRowMeasureWidthPx(row)) != null) hits += 1;
  }
  if (__DEV__) noteChatOpenLayoutWarm(hits, total);
  return { hits, total };
}

/** Тихая (без дев-счётчиков) проверка: все тексты окна показа с замером. */
function threadWindowTextMeasuresWarm(rows: readonly ThreadBubbleItem[]): boolean {
  for (const row of rows.slice(-THREAD_REVEAL_WINDOW)) {
    if (!row.text?.trim()) continue;
    if (getCachedBodyMeasure(row.text, threadRowMeasureWidthPx(row)) == null) {
      return false;
    }
  }
  return true;
}

/** Опрос готовности замеров окна (кэш наполняют хост и сами ячейки). */
const TEXT_LAYOUT_POLL_MS = 32;
/** Потолок ожидания замеров перед показом — страховка от зависшего хоста. */
const TEXT_LAYOUT_READY_CAP_MS = 400;

function threadListItemHasMessage(item: ThreadListItem, messageUuid: string): boolean {
  return item.message.messageUuid === messageUuid;
}

export default function ThreadScreen() {
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: windowHeight } = useWindowDimensions();
  /** Исходящий текст — без peer inset (как ChatMessageBubble isFromMe). */
  const outgoingLiftCtx = useMemo(
    () => ({
      maxInnerWidthPx: maxTextBubbleInnerWidth({
        screenWidth,
        isFromMe: true,
        showPeerAvatar: false,
        isPeerIndented: false,
      }),
    }),
    [screenWidth],
  );
  /**
   * Peer inset: `showPeerAvatar || isPeerIndented` дают одну ширину
   * (`messageBubbleLayout.peerInset`) — и хвост с аватаром, и inPeerGroup.
   */
  const peerLiftCtx = useMemo(
    () => ({
      maxInnerWidthPx: maxTextBubbleInnerWidth({
        screenWidth,
        isFromMe: false,
        showPeerAvatar: false,
        isPeerIndented: true,
      }),
    }),
    [screenWidth],
  );
  const navigation = useNavigation();
  const tabBarBottomInset = Math.max(insets.bottom, 8);
  const systemNavBottomInset = resolveMessagesDockBottomInset(insets);

  const {
    dockStickyStyle,
    emojiPanelLayerStyle,
    jumpBtnBottomStyle,
    listGapPx,
    listInsetZeroSv,
    freezeListSv,
    listAnimatedRef,
    pinListToBottom,
    setListPinned,
    listLiftStyle,
    listPlaceholderStyle,
    hideListUntilReady,
    allowListReveal,
    setListRevealQuietFrames,
    setListTextLayoutReady,
    revealListNow,
    onListLoad,
    onListContentSizeChange,
    listRevealed,
    finishEnterTransition,
    composeBaselinePx,
    emojiPanelHeightPx,
    emojiPanelReady,
    onComposeShellLayout,
    composeGrowthHoldSv,
    onDockColumnIdleLayout,
    setDeleteBarHeightPx,
    recalibrateComposeBaseline,
    emojiPanelMounted,
    emojiAccessoryActive,
    keyboardOpen,
    composeDockActive,
    closeEmoji,
    toggleEmoji,
    dismissKeyboard,
    resetDock,
  } = useChatComposeDock({ systemNavBottomInsetPx: systemNavBottomInset });

  /** Зона интерактивного свайпа над клавиатурой = высота закрытого дока. */
  const kgaOffsetPx = composeBaselinePx || COMPOSE_BASELINE_FALLBACK_PX;
  /**
   * FlashList строит тип анимированного компонента из `renderScrollComponent`
   * и мемоизирует его по идентичности колбэка, поэтому новая идентичность
   * перемонтирует весь скролл: теряется позиция и все смонтированные ячейки.
   * `kgaOffsetPx` меняется, как только док измерит baseline, — читаем его
   * через ref, чтобы не захватывать в замыкание.
   */
  const kgaOffsetRef = useRef(kgaOffsetPx);
  kgaOffsetRef.current = kgaOffsetPx;

  const composeRef = useRef<ChatComposeFieldHandle>(null);
  const moreBtnRef = useRef<View>(null);
  const dockFooterRef = useAnimatedRef<Reanimated.View>();
  const chatHeaderWrapRef = useRef<View>(null);
  const atBottomRef = useRef(true);
  const [menuTarget, setMenuTarget] = useState<{
    message: ThreadBubbleItem;
    anchor: BubbleAnchorRect;
    placement: "above" | "below";
    shiftY: number;
    panelHeight: number;
    feedTopY: number | null;
  } | null>(null);
  const [feedTopY, setFeedTopY] = useState<number | null>(null);
  const [feedBottomY, setFeedBottomY] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<MessageReplyDraft | null>(null);
  const [pendingReportMessage, setPendingReportMessage] = useState<ThreadBubbleItem | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const closeMessageMenu = useCallback(() => {
    setMenuTarget(null);
  }, []);
  const closeMessageMenuRef = useRef(closeMessageMenu);
  closeMessageMenuRef.current = closeMessageMenu;

  const applyFeedBounds = useCallback((topY: number, bottomY: number) => {
    setFeedTopY(topY);
    setFeedBottomY(bottomY);
  }, []);

  const syncFeedBoundsY = useCallback(() => {
    chatHeaderWrapRef.current?.measureInWindow((_headerX, headerY, _headerW, headerH) => {
      const dividerY = headerY + headerH;
      runOnUI(() => {
        const dock = measure(dockFooterRef);
        if (dock == null) return;
        runOnJS(applyFeedBounds)(dividerY, dock.pageY);
      })();
    });
  }, [applyFeedBounds, dockFooterRef]);

  useEffect(() => {
    syncFeedBoundsY();
    const frame = requestAnimationFrame(syncFeedBoundsY);
    const willHide = KeyboardEvents.addListener("keyboardWillHide", syncFeedBoundsY);
    const didHide = KeyboardEvents.addListener("keyboardDidHide", syncFeedBoundsY);
    const willShow = KeyboardEvents.addListener("keyboardWillShow", syncFeedBoundsY);
    const didShow = KeyboardEvents.addListener("keyboardDidShow", syncFeedBoundsY);
    return () => {
      cancelAnimationFrame(frame);
      willHide.remove();
      didHide.remove();
      willShow.remove();
      didShow.remove();
    };
  }, [syncFeedBoundsY]);

  const clearReplyDraft = useCallback(() => {
    setReplyTo(null);
    setDeleteBarHeightPx(0);
  }, [setDeleteBarHeightPx]);

  const params = useLocalSearchParams<{
    conversationUuid: string;
    kind?: string;
    title?: string;
    otherUserUuid?: string;
    otherDisplayName?: string;
    otherUsername?: string;
    otherAvatarUuid?: string;
    otherAccountBlocked?: string;
    otherUserIsOnline?: string;
    otherUserLastSeenAt?: string;
  }>();

  const conversationUuid = routeParam(params.conversationUuid);
  const isGroupChat = routeParam(params.kind) === "groupChat";
  const groupTitleHint = routeParam(params.title);
  const paramOtherUserUuid = routeParam(params.otherUserUuid);
  // Дев-трасса: сколько раз экран перерендерился от тапа до показа.
  if (__DEV__) noteChatOpenScreenRender(conversationUuid);

  const scrollTrackingReadyRef = useRef(false);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  /**
   * Новейший createdAt на момент посева: всё, что не новее его, — история
   * (дорасшифровка фоном, дозагрузка страницы), а не живое сообщение.
   * Без этой отсечки фоновые волны расшифровки длинных чатов считались
   * «входящими»: insertLift + pin на каждую волну — лента дёргалась и мигала.
   */
  const seedNewestCreatedAtRef = useRef("");
  /** Компенсация скачка layout → анимация подъёма ленты+пузыря одним transform. */
  const insertLiftSv = useSharedValue(0);
  /** Контр к insertLift для аватара хвоста peer-группы (паритет Web holdViewport). */
  const peerAvatarHoldSv = useSharedValue(0);
  const listInsertLiftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: insertLiftSv.value }],
  }));
  const peerAvatarHoldStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: peerAvatarHoldSv.value }],
  }));

  /**
   * Держим UI-runtime/DisplayLink тёплым, пока чат в фокусе: после простоя
   * без жестов кадры «засыпают», и insertLift стартует рывком только на тап.
   */
  const chatUiFrameKeepAlive = useFrameCallback(() => {
    "worklet";
  }, false);

  /** Один тихий догруз на открытие треда (сбрасывается при смене треда). */
  const postRevealRefreshedRef = useRef<string | null>(null);

  /**
   * Свежесть listRevealed на переиспользованном экране. setListRevealed(false)
   * из layout-сброса попадает во ВТОРОЙ коммит, а passive-эффекты ПЕРВОГО
   * коммита нового треда выполняются с устаревшим listRevealed=true прошлого
   * треда: mark-read с инвалидацией списка бесед, таймеры доклейки/волн и
   * трасса reveal стреляли прямо в окно открытия. Ref взводится синхронно в
   * layout-сбросе (раньше любых passive), снимается эффектом на
   * listRevealed=false (второй коммит) — потребители reveal-эффектов читают
   * его в теле и пропускают устаревший первый коммит.
   */
  const listRevealedStaleRef = useRef(false);

  /**
   * Пост-показ по фазам: сперва доклейка хвоста истории за окном первого
   * коммита, затем отпуск фоновых волн расшифровки. До показа лента монтирует
   * только окно вьюпорта — остальное принципиально после первого кадра.
   */
  const [listWindowExpanded, setListWindowExpanded] = useState(false);
  const [decryptWavesReleased, setDecryptWavesReleased] = useState(false);

  /**
   * Layout-эффект, не useEffect: роутер переиспользует инстанс экрана при
   * переходе чат → список → чат, и listRevealSv остаётся 1 от прошлого треда.
   * Пассивный эффект гонялся с коммитом ячеек FlashList и проигрывал —
   * пара кадров видимой неякорёной ленты нового треда (вспышка), потом
   * скрытие; а поздний hide обрывал уже запущенный цикл показа, и лента
   * ждала дедлайна LIST_REVEAL_DEADLINE_MS (~секунда чёрного экрана).
   * Layout-эффект прячет ленту синхронно в коммите смены треда — до paint.
   *
   * Guard по uuid: перезапуск эффекта БЕЗ смены треда (flap isGroupChat из
   * параметров маршрута и т.п.) не должен прятать уже показанную ленту.
   * Такой ложный hide — «редкое мигание»: кадр контента → чёрный экран, и
   * повторный показ доезжает только по потолку ожидания (FlashList без
   * ремоунта onLoad не повторяет).
   */
  const threadResetUuidRef = useRef("");
  useLayoutEffect(() => {
    if (threadResetUuidRef.current === conversationUuid) {
      if (__DEV__) {
        console.log(
          `[chat-open] сброс пропущен: тред тот же (${conversationUuid}, group=${String(isGroupChat)})`,
        );
      }
      return;
    }
    threadResetUuidRef.current = conversationUuid;
    markChatOpenStage("mount", conversationUuid);
    listRevealedStaleRef.current = true;
    if (__DEV__) cellHeightsRef.current.clear();
    resetDock();
    hideListUntilReady();
    setMenuTarget(null);
    setReplyTo(null);
    // Позиция ленты — величина потреда: перенесённая из прошлого треда, она
    // оставила бы новый тред «отмотанным вверх» (без возврата к якорю на
    // входящие) и могла бы показать в нём чужую плашку «Новые сообщения».
    atBottomRef.current = true;
    setShowJumpToLatest(false);
    resetBirthTracking();
    scrollTrackingReadyRef.current = false;
    seenMessageIdsRef.current = new Set();
    seedNewestCreatedAtRef.current = "";
    insertLiftSv.value = 0;
    peerAvatarHoldSv.value = 0;
    postRevealRefreshedRef.current = null;
    setListWindowExpanded(false);
    setDecryptWavesReleased(false);
    // resetDock is stable (ref-backed); only re-run on thread / kind change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationUuid, isGroupChat]);

  useEffect(() => {
    // Устаревший true первого коммита переиспользованного экрана снимаем здесь:
    // это самый ранний reveal-эффект, дальше по файлу все читают уже false.
    if (!listRevealed) {
      listRevealedStaleRef.current = false;
      return;
    }
    if (listRevealedStaleRef.current) return;
    // Доклейка раньше отпуска волн: оба — коммиты FlashList, и разнесение по
    // времени держит кадры сразу после показа свободными для жестов.
    const expand = setTimeout(
      () => setListWindowExpanded(true),
      LIST_WINDOW_EXPAND_DELAY_MS,
    );
    const waves = setTimeout(
      () => setDecryptWavesReleased(true),
      WAVES_RELEASE_DELAY_MS,
    );
    return () => {
      clearTimeout(expand);
      clearTimeout(waves);
    };
  }, [listRevealed]);

  /**
   * Инсет через ref: смена insets.bottom (скрытие таб-бара, жестовая панель)
   * меняла бы зависимость focus-эффекта, и его cleanup дёргал resetDock
   * посреди открытого чата — сброс базлайна дока и шум content-size.
   */
  const tabBarBottomInsetRef = useRef(tabBarBottomInset);
  useEffect(() => {
    tabBarBottomInsetRef.current = tabBarBottomInset;
  }, [tabBarBottomInset]);
  useFocusEffect(
    useCallback(() => {
      applyMessagesTabBarHidden(navigation, tabBarBottomInsetRef.current, true);
      chatUiFrameKeepAlive.setActive(true);
      return () => {
        chatUiFrameKeepAlive.setActive(false);
        applyMessagesTabBarHidden(navigation, tabBarBottomInsetRef.current, false);
        resetDock();
      };
    }, [chatUiFrameKeepAlive, navigation, resetDock]),
  );

  /**
   * Перехода нет (`animation: "none"`): заглушке можно появляться сразу,
   * как только hideListUntilReady сбросил ленту. Эффект ниже hide-эффекта
   * по порядку объявления — enter-флаг успевает подняться и опуститься
   * в одном проходе, без кадра «заглушка до hide».
   */
  useEffect(() => {
    finishEnterTransition();
  }, [conversationUuid, finishEnterTransition]);

  const paramOtherDisplayName = routeParam(params.otherDisplayName);
  const paramOtherUsername = routeParam(params.otherUsername);
  const paramOtherAvatarUuid = routeParam(params.otherAvatarUuid);
  const paramOtherAccountBlocked = params.otherAccountBlocked;
  const paramOtherUserIsOnline = params.otherUserIsOnline;
  const paramOtherUserLastSeenAt = routeParam(params.otherUserLastSeenAt);
  const [sending, setSending] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);

  const me = useSessionStore((s) => s.me);
  const hydrateOverlay = useChatListOverlayStore((s) => s.hydrate);
  const setOverlayFscpKeys = useChatListOverlayStore((s) => s.setFscpKeys);
  const setMuted = useChatListOverlayStore((s) => s.setMuted);
  const setGroupArchived = useChatListOverlayStore((s) => s.setGroupArchived);
  const mutedByPeer = useChatListOverlayStore((s) => s.state.mutedByPeer);
  const archivedByPeer = useChatListOverlayStore((s) => s.state.archivedByPeer);
  const archivedByConversation = useChatListOverlayStore(
    (s) => s.state.archivedByConversation ?? {},
  );
  const customEntityCount = useChatListOverlayStore((s) => s.state.entities.length);
  const temporaryUntilByPeer = useTemporaryMuteUntilByPeer();
  const archivedCount = useMemo(() => {
    const owner = me?.userUuid?.trim();
    const dmSet = owner
      ? dmConversationUuidsOfArchivedPeers(owner, archivedByPeer)
      : undefined;
    return countArchivedForFolderIcon(archivedByPeer, archivedByConversation, dmSet);
  }, [archivedByConversation, archivedByPeer, me?.userUuid]);
  const canArchivePeer = useMemo(
    () => canArchiveChatListPeer(archivedCount, customEntityCount),
    [archivedCount, customEntityCount],
  );
  const groupIsArchived = isConversationArchived(conversationUuid, archivedByConversation);

  useEffect(() => {
    hydrateOverlay(me?.userUuid ?? null);
  }, [hydrateOverlay, me?.userUuid]);
  const fscpStatus = useFscpStore((s) => s.status);
  const fscpReady = useFscpStore((s) => s.status === "ready");
  const fscpMaterial = useFscpStore((s) => s.material);
  const fscpCanDecrypt = useFscpStore((s) => s.canDecrypt);
  const fscpDecryptKey = useFscpStore((s) => s.localPubKey);
  const canSend = useFscpStore((s) => s.canSend);
  const decryptWirePlaintext = useFscpStore((s) => s.decryptWirePlaintext);
  const organizerKeysReady = Boolean(fscpMaterial && fscpCanDecrypt());

  useEffect(() => {
    if (fscpMaterial && fscpCanDecrypt()) {
      setOverlayFscpKeys({
        agreementPrivateKey: fscpMaterial.agreementPrivateKey,
        signingPrivateKey: fscpMaterial.signingPrivateKey,
      });
    } else {
      setOverlayFscpKeys(null);
    }
  }, [fscpMaterial, fscpCanDecrypt, fscpStatus, setOverlayFscpKeys]);
  const {
    images: composeImages,
    hasPendingPrepare,
    clearImages,
    removeImageAt,
    pickImages,
  } = useMessageComposeImages();

  const {
    mode: voiceMode,
    draft: voiceDraft,
    canSendVoice,
    setVoiceFromRecording,
    enterVoiceMode,
    clearDraft: clearVoiceDraft,
  } = useMessageComposeVoice();

  const voiceRecorder = useVoiceRecorder({
    onRecorded: setVoiceFromRecording,
  });

  const typingEmitterRef = useRef<TypingEmitter | null>(null);
  const prevVoiceModeRef = useRef(voiceMode);
  const prevComposeImageCountRef = useRef(composeImages.length);
  useEffect(() => {
    const wasVoice = prevVoiceModeRef.current === "voice";
    prevVoiceModeRef.current = voiceMode;
    if (wasVoice && voiceMode !== "voice") {
      recalibrateComposeBaseline();
    }
  }, [voiceMode, recalibrateComposeBaseline]);

  useEffect(() => {
    const prevCount = prevComposeImageCountRef.current;
    prevComposeImageCountRef.current = composeImages.length;
    if (prevCount > 0 && composeImages.length === 0) {
      recalibrateComposeBaseline();
    }
  }, [composeImages.length, recalibrateComposeBaseline]);

  useEffect(() => {
    if (voiceRecorder.error) {
      Alert.alert("Запись", voiceRecorder.error);
      voiceRecorder.setError(null);
    }
  }, [voiceRecorder.error, voiceRecorder]);

  useEffect(() => {
    if (voiceDraft?.transcodeError) {
      Alert.alert("Голосовое", voiceDraft.transcodeError);
      clearVoiceDraft();
    }
  }, [voiceDraft?.transcodeError, clearVoiceDraft]);

  // Images / voice / recorder reset when switching thread or DM↔group.
  useEffect(() => {
    clearImages();
    clearVoiceDraft();
    void voiceRecorder.discard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationUuid, isGroupChat]);

  const queryClient = useQueryClient();

  const conversationsForGroup = useQuery({
    queryKey: ["conversations"],
    queryFn: () => apiGetConversations(),
    enabled: isGroupChat,
    staleTime: 30_000,
  });
  const groupThread = useGroupChatThread({
    enabled: isGroupChat,
    conversationUuid,
    titleHint: groupTitleHint,
    meUserUuid: me?.userUuid,
    dmConversations: conversationsForGroup.data?.items ?? [],
  });

  const peer = useMemo((): ChatPeerInfo => {
    const fromList = queryClient
      .getQueryData<{ items: MsgConversationDto[] }>(["conversations"])
      ?.items
      ?.find((c) => c.conversationUuid === conversationUuid);
    if (fromList) {
      return {
        conversationUuid,
        otherUserUuid: fromList.otherUserUuid,
        otherUsername: fromList.otherUsername,
        otherDisplayName: fromList.otherDisplayName,
        otherAvatarUuid: fromList.otherAvatarUuid,
        otherAccountBlocked: fromList.otherAccountBlocked,
        otherUserIsOnline: fromList.otherUserIsOnline,
        otherUserLastSeenAt: fromList.otherUserLastSeenAt,
      };
    }
    return {
      conversationUuid,
      otherUserUuid: paramOtherUserUuid,
      otherUsername: paramOtherUsername,
      otherDisplayName: paramOtherDisplayName || paramOtherUsername || "Пользователь",
      otherAvatarUuid: paramOtherAvatarUuid.trim() ? paramOtherAvatarUuid : null,
      otherAccountBlocked: parseBoolParam(paramOtherAccountBlocked),
      otherUserIsOnline: parseBoolParam(paramOtherUserIsOnline),
      otherUserLastSeenAt: paramOtherUserLastSeenAt.trim() || null,
    };
  }, [
    conversationUuid,
    queryClient,
    paramOtherAccountBlocked,
    paramOtherAvatarUuid,
    paramOtherDisplayName,
    paramOtherUserIsOnline,
    paramOtherUserLastSeenAt,
    paramOtherUserUuid,
    paramOtherUsername,
  ]);

  const otherUserUuid = peer.otherUserUuid || paramOtherUserUuid;
  const peerDisplayName = peer.otherDisplayName || peer.otherUsername || "Пользователь";
  const temporaryMuteActive =
    !!otherUserUuid &&
    temporaryUntilByPeer[otherUserUuid] != null &&
    temporaryUntilByPeer[otherUserUuid]! > Date.now();
  const conversationMuted =
    !!otherUserUuid && (otherUserUuid in mutedByPeer || temporaryMuteActive);

  useEffect(() => {
    if (isGroupChat || !conversationUuid || otherUserUuid) return;
    void queryClient
      .fetchQuery({
        queryKey: ["conversations"],
        queryFn: () => apiGetConversations(),
        staleTime: 30_000,
      })
      .catch(() => undefined);
  }, [conversationUuid, isGroupChat, otherUserUuid, queryClient]);

  const messagesQuery = useQuery({
    queryKey: ["messages", conversationUuid, otherUserUuid || ""],
    enabled: !isGroupChat && !!conversationUuid && !!otherUserUuid,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    initialData: () => {
      if (!otherUserUuid) return undefined;
      const cached = messageThreadCache.get(conversationUuid);
      return cached
        ? applyMessagesPageToCaches({
            conversationUuid,
            otherUserUuid,
            page: { items: cached, nextCursor: null },
          })
        : undefined;
    },
    queryFn: async () => {
      const page = await apiGetMessages(conversationUuid, undefined, otherUserUuid || undefined);
      return applyMessagesPageToCaches({
        conversationUuid,
        otherUserUuid,
        page,
      });
    },
  });

  useEffect(() => {
    if (!conversationUuid) return;
    setActiveMessageThread(conversationUuid);
    return () => setActiveMessageThread(null);
  }, [conversationUuid]);

  useEffect(() => {
    if (!conversationUuid) return;
    const norm = conversationUuid.toLowerCase();
    return subscribeMessageRealtime((incomingUuid) => {
      if (incomingUuid.toLowerCase() !== norm) return;
      // Background/push must not mark-read (or imply the user is looking at chat).
      if (AppState.currentState !== "active") return;
      if (isGroupChat) {
        void groupThread.refetchMessages();
        void groupThread.markRead();
      } else {
        void messagesQuery.refetch();
        void apiMarkConversationRead(conversationUuid)
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: ["conversations"] });
            requestTabBadgesRefresh();
          })
          .catch(() => undefined);
      }
      void dismissMessagePushNotifications(conversationUuid);
    });
  }, [
    conversationUuid,
    groupThread.markRead,
    groupThread.refetchMessages,
    isGroupChat,
    messagesQuery,
    queryClient,
  ]);

  useEffect(() => {
    if (isGroupChat || !conversationUuid) return;
    const norm = conversationUuid.toLowerCase();
    return subscribeRead((detail) => {
      if (detail.conversationUuid.trim().toLowerCase() !== norm) return;
      markOutgoingMessagesReadInCache({
        queryClient,
        conversationUuid,
        otherUserUuid: otherUserUuid || undefined,
      });
    });
  }, [conversationUuid, isGroupChat, otherUserUuid, queryClient]);

  /**
   * Read-ack — после первого видимого кадра ленты, не в окне открытия:
   * markRead → invalidate(conversations) → рефетч списка + расшифровка превью
   * раньше падали ровно в кадры монтажа пузырей. Смысл не меняется —
   * «прочитано, когда увидел».
   */
  useEffect(() => {
    if (!listRevealed || !conversationUuid) return;
    if (listRevealedStaleRef.current) return;
    if (isGroupChat) {
      void groupThread.markRead();
      void dismissMessagePushNotifications(conversationUuid);
      return;
    }
    void apiMarkConversationRead(conversationUuid)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        requestTabBadgesRefresh();
        return dismissMessagePushNotifications(conversationUuid);
      })
      .catch(() => undefined);
  }, [conversationUuid, groupThread.markRead, isGroupChat, listRevealed, queryClient]);

  /**
   * Тихий догруз треда — строго ПОСЛЕ первого видимого кадра ленты (reveal),
   * а не «после интеракций»: с `animation: "none"` InteractionManager
   * срабатывал почти сразу, и сетевой merge с ре-рендерами падал в середину
   * открытия. Строки сохраняют identity (structural sharing RQ +
   * identity-preserving merge в decrypt-хуке), поэтому ответ «без изменений»
   * не перерисовывает ни одной ячейки.
   */
  const groupThreadRef = useRef(groupThread);
  groupThreadRef.current = groupThread;
  useEffect(() => {
    if (!listRevealed || !conversationUuid) return;
    if (listRevealedStaleRef.current) return;
    if (!isGroupChat && !otherUserUuid) return;
    if (postRevealRefreshedRef.current === conversationUuid) return;
    postRevealRefreshedRef.current = conversationUuid;
    const timer = setTimeout(() => {
      if (isGroupChat) {
        void groupThreadRef.current.refetchMessages();
        return;
      }
      void queryClient
        .fetchQuery({
          queryKey: ["messages", conversationUuid, otherUserUuid || ""],
          queryFn: async () => {
            const page = await apiGetMessages(
              conversationUuid,
              undefined,
              otherUserUuid || undefined,
            );
            return applyMessagesPageToCaches({
              conversationUuid,
              otherUserUuid,
              page,
            });
          },
          staleTime: 60_000,
        })
        .catch(() => undefined);
    }, POST_REVEAL_REFRESH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [conversationUuid, isGroupChat, listRevealed, otherUserUuid, queryClient]);

  const messages = useMemo(() => {
    if (isGroupChat) return groupThread.messages;
    return (
      messagesQuery.data?.items ??
      messageThreadCache.get(conversationUuid) ??
      EMPTY_MESSAGES
    );
  }, [
    conversationUuid,
    groupThread.messages,
    isGroupChat,
    messagesQuery.data?.items,
  ]);

  const messagesKey = useMemo(
    () =>
      messages
        .map((m) => {
          const enc = (m.encryptedPayload ?? "").slice(0, 48);
          return `${m.messageUuid}:${m.createdAt}:${m.isRead ? 1 : 0}:${enc}`;
        })
        .join("|"),
    [messages],
  );

  const decrypted = useThreadMessageDecrypt({
    conversationUuid,
    messages,
    messagesKey,
    isGroupChat,
    viewerUserUuid: me?.userUuid,
    fscpReady,
    fscpDecryptKey,
    decryptWirePlaintext,
    // Фоновая дорасшифровка истории — не просто после показа, а после паузы
    // (WAVES_RELEASE_DELAY_MS): волна, отпущенная в кадр показа, коммитила
    // десятки строк ровно в момент, когда пользователь начинает скроллить.
    holdBackgroundWaves: !decryptWavesReleased,
  });

  /**
   * Лента перевёрнута: данные от новых к старым (индекс 0 у якоря).
   * Группы по raw `decrypted` (стабильный groupKey); чужие decrypting не в item —
   * иначе мелькает «Расшифровка…». Item-обёртки переиспользуются между
   * пересборками (reuseThreadListItems) — иначе каждый setRows ре-рендерил
   * весь вьюпорт ячеек.
   */
  const listDataPrevRef = useRef<readonly ThreadListItem[]>([]);
  const listData = useMemo(() => {
    const chronological = buildThreadListItems(
      decrypted,
      (m) => m.isFromMe || m.decryptState !== "decrypting",
    );
    chronological.reverse();
    const reused = reuseThreadListItems(listDataPrevRef.current, chronological);
    listDataPrevRef.current = reused;
    return reused;
  }, [decrypted]);

  /**
   * Окно первого коммита: до показа FlashList получает только строки,
   * закрывающие вьюпорт (+запас), — медиа-чаты не монтируют 2–3 экрана
   * истории до первого кадра. После показа окно доклеивается до полного
   * listData (эффект по listRevealed выше). Для коротких/текстовых лент срез
   * не срабатывает и возвращается тот же массив — ничего не перерендеривается.
   */
  const listDataWindow = useMemo(() => {
    if (listWindowExpanded) return listData;
    // Зона дока (listGapPx) — не вьюпорт ленты: без вычета окно тянуло в
    // первый коммит 1–2 лишних пузыря, а монтаж ячеек — самая дорогая фаза
    // открытия (load−cell в трассе). Запас поверх остаётся полным.
    const target = Math.max(0, windowHeight - listGapPx) + LIST_WINDOW_BUFFER_PX;
    return sliceThreadListToViewport(listData, target, {
      own: outgoingLiftCtx,
      peer: peerLiftCtx,
    });
  }, [listData, listGapPx, listWindowExpanded, outgoingLiftCtx, peerLiftCtx, windowHeight]);
  // Дев-трасса: FlashList впервые получает непустые данные в этом рендере.
  if (__DEV__ && listDataWindow.length > 0) markChatOpenStage("data", conversationUuid);

  const listDataRef = useRef(listDataWindow);
  listDataRef.current = listDataWindow;
  /**
   * FlashList cells are `position: absolute`. Inner zIndex cannot stack above a
   * later sibling cell, so a menu that opens toward older messages (visually
   * down) is covered. Raise overflow + zIndex on the cell that owns the menu.
   */
  /**
   * Дев-трассировка осадки по ячейкам: базовые высоты пишутся с монтажа, лог —
   * только на изменении высоты в окне осадки после reveal. Называет виновника
   * сдвигов content-size поимённо (какой пузырь и на сколько подрос/сжался).
   */
  const cellHeightsRef = useRef(new Map<string, number>());

  const MenuCellRenderer = useMemo(
    () =>
      forwardRef<
        View,
        { index?: number; style?: StyleProp<ViewStyle>; children?: React.ReactNode }
      >(function MessageMenuCell({ style, index, children, ...rest }, ref) {
        const menuUuid = useOpenMessageMenuUuid();
        const item = typeof index === "number" ? listDataRef.current[index] : undefined;
        const isOwner = Boolean(
          menuUuid && item && threadListItemHasMessage(item, menuUuid),
        );
        const blocked = Boolean(menuUuid && !isOwner);
        const onCellLayout = __DEV__
          ? (e: LayoutChangeEvent) => {
              const h = Math.round(e.nativeEvent.layout.height);
              const key = item ? item.message.messageUuid : `i${String(index)}`;
              const prev = cellHeightsRef.current.get(key);
              cellHeightsRef.current.set(key, h);
              const at = revealedAtRef.current;
              if (at <= 0 || prev == null || prev === h) return;
              const dt = Date.now() - at;
              if (dt > 2000) return;
              const row = item?.message;
              const label = !row
                ? "?"
                : row.voiceBlock
                  ? "голос"
                  : row.imageBlocks.length > 0
                    ? "фото"
                    : `«${row.text.slice(0, 16)}»`;
              console.log(
                `[chat-settle] ячейка ${label} ${prev}→${h} (+${dt}мс после reveal)`,
              );
            }
          : undefined;
        return (
          <View
            ref={ref}
            collapsable={false}
            {...rest}
            pointerEvents="box-none"
            style={[style, styles.menuCell, isOwner ? styles.menuCellOpen : null]}
            onLayout={onCellLayout}
          >
            {children}
            <GesturePressable
              accessibilityRole="button"
              accessibilityLabel="Закрыть меню"
              pointerEvents={blocked ? "auto" : "none"}
              style={styles.menuCellDismiss}
              onPress={() => closeMessageMenuRef.current()}
            />
          </View>
        );
      }),
    [],
  );

  const listMessageCount = useMemo(() => {
    let n = 0;
    forEachThreadListMessage(listData, () => {
      n += 1;
    });
    return n;
  }, [listData]);

  const hasDecryptFailures = useMemo(
    () => fscpReady && decrypted.some((row) => row.decryptState === "failed"),
    [decrypted, fscpReady],
  );

  /**
   * Тред можно показывать, когда новейшие THREAD_REVEAL_WINDOW сообщений
   * терминальны (включая скрытые peer-decrypting): вся видимая часть у якоря
   * собрана и высоты больше не поедут. Ждать весь тред нельзя — время
   * открытия росло линейно с историей. Старые строки дорасшифровываются
   * фоном: peer-строки до готовности скрыты и появляются выше вьюпорта.
   */
  const threadReady = useMemo(() => {
    if (listMessageCount === 0) return false;
    const start = Math.max(0, decrypted.length - THREAD_REVEAL_WINDOW);
    for (let i = decrypted.length - 1; i >= start; i--) {
      if (decrypted[i]!.decryptState === "decrypting") return false;
    }
    return true;
  }, [decrypted, listMessageCount]);
  const listPending =
    (isGroupChat ? groupThread.isLoading : messagesQuery.isLoading) ||
    (listMessageCount > 0 && !threadReady);

  /**
   * Показ ждёт ещё и замера дока. У перевёрнутой ленты зазор под последним
   * сообщением — это `contentInset`, то есть inset задаёт видимую позицию
   * напрямую. До замера он считается по оценке `COMPOSE_BASELINE_FALLBACK_PX`,
   * и пока она не сошлась с реальной высотой поля, лента стоит не на месте.
   * На холодном открытии это незаметно (расшифровка дольше замера), на тёплом
   * тред готов на первом кадре — и без этого условия показ попадает в окно
   * оценки.
   */
  /** Тред, для которого FlashList уже отдал onLoad (см. self-heal ниже). */
  const listLoadFiredUuidRef = useRef("");
  useEffect(() => {
    if (threadReady) {
      markChatOpenStage("ready", conversationUuid);
      const warm = reportChatOpenLayoutWarm(decrypted);
      // Всё окно показа с прогретыми замерами: высоты финальны с первого
      // коммита, коррекций не будет — сужаем гейт тишины дока до одного
      // кадра (−2 кадра ожидания). Иначе оставляем консервативный дефолт.
      if (warm.total > 0 && warm.hits === warm.total) {
        setListRevealQuietFrames(1);
      }
      // Холодный тред: тап-прогрев покрыл только расшифрованное ДО тапа.
      // Ставим замеры сразу после расшифровки — хост успевает до onLoad
      // FlashList, и коррекции высот не тревожат гейт тишины.
      warmThreadTextLayoutFromRows(decrypted);
    }
    // `listRevealed` в зависимостях — самовосстановление: hide после уже
    // запущенного цикла показа (сброс на смене треда и т.п.) роняет
    // listRevealed в false, и эффект перезапускает показ сразу, а не через
    // дедлайн LIST_REVEAL_DEADLINE_MS. После состоявшегося показа повторный
    // вызов — no-op (guard listRevealStartedSv).
    if (threadReady && composeBaselinePx > 0) {
      // FlashList уже отдал onLoad для этого треда, но hide сбросил флаг —
      // без ремоунта onLoad не повторится, и повторный показ ждал бы потолок
      // кадров (~1 c чёрного экрана). Подтверждаем сами.
      if (!listRevealed && listLoadFiredUuidRef.current === conversationUuid) {
        onListLoad();
      }
      allowListReveal();
    }
    // Тред мог смениться на такой же готовый — сброс делает эффект по треду выше.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowListReveal, composeBaselinePx, conversationUuid, listRevealed, onListLoad, setListRevealQuietFrames, threadReady]);

  /**
   * Гейт финальной раскладки текста: пока замеры тел окна показа не в кэше,
   * показ не открывается (SV-гейт дока) — иначе пузыри доизмерялись бы уже на
   * экране (видимый сдвиг: «элементы появляются не сразу»). Кэш наполняют
   * срочная полоса хоста замеров и сами ячейки — опрашиваем дёшево (≤16
   * кэш-чтений раз в 32 мс); потолок — страховка от любого зависания.
   */
  useEffect(() => {
    if (!threadReady) return;
    if (threadWindowTextMeasuresWarm(decrypted)) {
      setListTextLayoutReady(true);
      return;
    }
    setListTextLayoutReady(false);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const capped = Date.now() - startedAt >= TEXT_LAYOUT_READY_CAP_MS;
      if (!capped && !threadWindowTextMeasuresWarm(decrypted)) return;
      clearInterval(timer);
      if (__DEV__ && capped) {
        console.log("[chat-open] потолок ожидания замеров текста — показ как есть");
      }
      setListTextLayoutReady(true);
    }, TEXT_LAYOUT_POLL_MS);
    return () => clearInterval(timer);
  }, [conversationUuid, decrypted, setListTextLayoutReady, threadReady]);

  /** Момент показа ленты (JS) — окно дев-трассировки осадки пузырей. */
  const revealedAtRef = useRef(0);
  const settleOffsetLogsRef = useRef(0);
  useEffect(() => {
    if (listRevealed && !listRevealedStaleRef.current) {
      revealedAtRef.current = Date.now();
      settleOffsetLogsRef.current = 0;
      markChatOpenStage("reveal", conversationUuid);
    } else if (!listRevealed) {
      revealedAtRef.current = 0;
    }
  }, [conversationUuid, listRevealed]);

  const reportInsertLiftSettle = useCallback((liftPx: number) => {
    const at = revealedAtRef.current;
    if (at <= 0) return;
    const dt = Date.now() - at;
    if (dt > 2000) return;
    console.log(
      `[chat-settle] insert-lift старт ${Math.round(liftPx)}px (+${dt}мс после reveal)`,
    );
  }, []);

  /**
   * Дев-ловушка ложного insertLift: по гварду createdAt лифт положен только
   * живым входящим, и запуск в первые секунды после показа — почти наверняка
   * «прыжок пузырей», о котором речь. Логируем только старт (0 → px).
   */
  // Гейт __DEV__ — внутри тела: функции должны стоять прямыми аргументами
  // хука, иначе babel-плагин Reanimated их не воркетизирует (краш UI-потока).
  // В release prepare сразу отдаёт null — реакция не срабатывает.
  useAnimatedReaction(
    () => {
      if (!__DEV__) return null;
      return insertLiftSv.value;
    },
    (cur, prev) => {
      if (!__DEV__ || cur === null || prev == null || cur === prev) return;
      if (prev === 0 && cur !== 0) runOnJS(reportInsertLiftSettle)(cur);
    },
    [reportInsertLiftSettle],
  );

  /**
   * Зеркала для стабильного onLoad-колбэка: тёплый быстрый путь читает
   * актуальные threadReady/decrypted без пересоздания колбэка на каждую волну.
   */
  const threadReadyRef = useRef(threadReady);
  threadReadyRef.current = threadReady;
  const decryptedRef = useRef(decrypted);
  decryptedRef.current = decrypted;

  const onFlashListLoad = useCallback(() => {
    listLoadFiredUuidRef.current = conversationUuid;
    markChatOpenStage("load", conversationUuid);
    onListLoad();
    // Тёплый быстрый путь: окно показа расшифровано и все замеры текста в
    // кэше — высоты финальны, коррекций не будет. Показываем в этом же
    // JS-коммите, минуя кадры тишины, верификацию якоря и runOnJS-роундтрип:
    // на тёплом открытии это ~100–250 мс тёмной заглушки.
    if (threadReadyRef.current && threadWindowTextMeasuresWarm(decryptedRef.current)) {
      revealListNow();
    }
  }, [conversationUuid, onListLoad, revealListNow]);

  /**
   * Ограничение сверху на ожидание. Расшифровка может не состояться вовсе —
   * при `blocked` (`!fscpReady`) строки остаются в `decrypting` навсегда, и без
   * этого лента не показалась бы никогда.
   */
  useEffect(() => {
    const timer = setTimeout(allowListReveal, LIST_REVEAL_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [allowListReveal, conversationUuid]);

  /**
   * Скроллит док: он единственный писатель офсета. Своей ручки скролла у ленты
   * нет намеренно — два писателя `contentOffset` дают борьбу за позицию.
   */
  const scrollToEnd = useCallback(
    (animated = true) => {
      if (listMessageCount === 0) return;
      pinListToBottom(animated);
      atBottomRef.current = true;
      setShowJumpToLatest(false);
    },
    [listMessageCount, pinListToBottom],
  );

  const onEndVisible = useCallback((visible: boolean) => {
    atBottomRef.current = visible;
    if (visible) setShowJumpToLatest(false);
  }, []);

  /**
   * Геометрия контент-контейнера перевёрнутой ленты (flip-пространство):
   *  - paddingTop — визуальный низ: зазор под доком (listGapPx). React-проп,
   *    а не inset KCSV: animatedProps-инсет терялся на React-коммитах FlashList
   *    (лента вставала вплотную к доку — «прыжок» в кадре показа);
   *  - paddingBottom — визуальный верх над самым старым сообщением: столько же,
   *    сколько marginBottom пузыря до линии compose.
   */
  const listContentStyle = useMemo(
    () => ({
      paddingTop: listGapPx,
      paddingBottom: floraMessages.bubbleRowGap,
    }),
    [listGapPx],
  );

  const renderScrollComponent = useCallback(
    (props: ScrollViewProps) => (
      <ChatScrollView
        {...props}
        offset={kgaOffsetRef.current}
        // Ноль: зазор дока — paddingTop контент-контейнера (listGapPx), а не
        // inset KCSV. Инсет жил в animatedProps, и React-коммиты FlashList
        // затирали его нативное значение — «прыжок пузырей» в кадре показа.
        extraContentPadding={listInsetZeroSv}
        freeze={freezeListSv}
        animatedRef={listAnimatedRef}
        // Математика KCSV перевёрнутой ленты: «конец» — офсет у нуля.
        inverted
      />
    ),
    [freezeListSv, listAnimatedRef, listInsetZeroSv],
  );

  // До paint (паритет Web useLayoutEffect): иначе после idle первый кадр без
  // counter-lift, а withTiming часто «оживает» только на жест.
  useLayoutEffect(() => {
    if (!threadReady || listMessageCount === 0) return;
    if (!scrollTrackingReadyRef.current) {
      // Посев из ПОЛНОЙ истории (`decrypted`), не из отфильтрованного listData:
      // чужие decrypting-строки в listData скрыты, и посев по нему считал бы
      // старую историю «входящими», когда фоновые волны расшифровки доводят её
      // до терминала, — insertLift + pin на каждую волну, лента дёргалась и
      // мигала при открытии длинных чатов.
      const keys: string[] = [];
      const ids = new Set<string>();
      let newestCreatedAt = "";
      for (const row of decrypted) {
        keys.push(row.clientMessageKey ?? row.messageUuid);
        ids.add(row.messageUuid);
        // Отсечка — только по серверным createdAt: у оптимистичных строк время
        // локальных часов, и при их уходе вперёд отсечка глотала бы живые входящие.
        if (row.sendStatus !== "sending" && row.createdAt > newestCreatedAt) {
          newestCreatedAt = row.createdAt;
        }
      }
      seedHydratedKeys(keys);
      seenMessageIdsRef.current = ids;
      seedNewestCreatedAtRef.current = newestCreatedAt;
      scrollTrackingReadyRef.current = true;
      return;
    }

    const seen = seenMessageIdsRef.current;
    const seedNewestCreatedAt = seedNewestCreatedAtRef.current;
    let incomingLiftPx = 0;
    let anyLiveNew = false;
    const newlyPeerUuids = new Set<string>();
    forEachThreadListMessage(listData, (row) => {
      // Ack исходящего меняет uuid на серверный; clientMessageKey уже в seen —
      // это не новое сообщение (иначе гонка с добавлением uuid в onSend).
      if (seen.has(row.messageUuid) || seen.has(row.clientMessageKey ?? "")) {
        seen.add(row.messageUuid);
        return;
      }
      seen.add(row.messageUuid);
      rememberClientMessageKey(
        row.messageUuid,
        row.clientMessageKey ?? row.messageUuid,
      );
      // Не новее посева — дорасшифрованная/дозагруженная история: без lift/плашки.
      if (row.createdAt <= seedNewestCreatedAt) {
        seedHydratedKeys([row.clientMessageKey ?? row.messageUuid]);
        return;
      }
      anyLiveNew = true;
      // Исходящие уже крутят insertLift в onSend; здесь — только peer delta.
      if (!row.isFromMe) {
        newlyPeerUuids.add(row.messageUuid);
        markBirthPending(row.clientMessageKey ?? row.messageUuid);
        incomingLiftPx += estimateRowInsertLiftPx(row, peerLiftCtx);
      }
    });
    if (!anyLiveNew) return;
    // Вне якоря приход строк позицию не трогает — только плашка (у якоря есть
    // допуск CHAT_AT_BOTTOM_THRESHOLD_PX, строка внутри него ушла бы под док).
    if (!atBottomRef.current) {
      setShowJumpToLatest(true);
      return;
    }
    // pin + lift в одном layout-кадре (как Web runInsertLift).
    pinListToBottom(false);
    setShowJumpToLatest(false);
    if (incomingLiftPx > 0) {
      // Hold только при append в уже видимую группу; новая группа — аватар
      // едет вместе с сообщением (без контр-transform).
      const holdAvatar = shouldHoldTrailingPeerAvatar(
        trailingPeerRunMessages(listData),
        newlyPeerUuids,
      );
      playChatListInsertLift(
        insertLiftSv,
        incomingLiftPx,
        holdAvatar ? peerAvatarHoldSv : undefined,
      );
    }
  }, [
    decrypted,
    insertLiftSv,
    listData,
    listMessageCount,
    peerAvatarHoldSv,
    peerLiftCtx,
    pinListToBottom,
    threadReady,
  ]);


  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isGroupChat && groupThread.membersOpen) {
        groupThread.setMembersOpen(false);
        return true;
      }
      if (emojiAccessoryActive) {
        closeEmoji();
        return true;
      }
      if (keyboardOpen) {
        dismissKeyboard();
        return true;
      }
      if (emojiPanelMounted) {
        // Хвост перехода (панель ещё дотлевает под клавиатурой) — закрыть.
        closeEmoji();
        return true;
      }
      if (menuTarget) {
        closeMessageMenu();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [
    emojiAccessoryActive,
    emojiPanelMounted,
    groupThread.membersOpen,
    groupThread.setMembersOpen,
    isGroupChat,
    keyboardOpen,
    closeEmoji,
    dismissKeyboard,
    menuTarget,
    closeMessageMenu,
  ]);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = event.nativeEvent;
      // Лента перевёрнута: последнее сообщение стоит на якоре (офсет 0), а не
      // в конце контента. Порог отсчитывается от якоря.
      const distanceFromAnchor = contentOffset.y - chatListAnchorOffset();
      if (__DEV__) {
        // Осадка офсета после показа: лента обязана стоять на якоре; любой
        // сдвиг в первые секунды — «прыжок» и есть. Первые 6 событий на показ.
        const at = revealedAtRef.current;
        if (
          at > 0 &&
          Date.now() - at < 2000 &&
          Math.abs(distanceFromAnchor) > 1 &&
          settleOffsetLogsRef.current < 6
        ) {
          settleOffsetLogsRef.current += 1;
          console.log(
            `[chat-settle] scroll-offset ${Math.round(distanceFromAnchor)}px от якоря ` +
              `(+${Date.now() - at}мс после reveal)`,
          );
        }
      }
      const atBottom = distanceFromAnchor <= CHAT_AT_BOTTOM_THRESHOLD_PX;
      atBottomRef.current = atBottom;
      // Здесь прижатие только включаем. Снять его может лишь жест — иначе
      // промежуточный кадр собственной коррекции низа отменил бы коррекцию.
      if (atBottom) setListPinned(true);
      onEndVisible(atBottom);
      if (shouldCloseMessageMenuOnListMotion("offset-change")) {
        closeMessageMenu();
      }
    },
    [closeMessageMenu, onEndVisible, setListPinned],
  );

  /** Программные скроллы дока drag-событий не порождают — снимает только палец. */
  const onScrollBeginDrag = useCallback(() => {
    setListPinned(false);
    if (shouldCloseMessageMenuOnListMotion("user-drag")) {
      closeMessageMenu();
    }
  }, [closeMessageMenu, setListPinned]);

  const copyMessageContent = useCallback(async (previewText: string) => {
    const ok = await copyTextToClipboard(previewText);
    if (!ok) {
      Alert.alert(
        "Копирование",
        "Буфер обмена недоступен. Пересоберите dev-client: npm run install:android:debug с флагом -ReplaceExisting.",
      );
    }
  }, []);

  const beginReplyToMessage = useCallback(
    (message: ThreadBubbleItem) => {
      const draft = replyDraftFromMessage(message, peerDisplayName);
      if (!draft) return;
      closeMessageMenu();
      setReplyTo(draft);
      closeEmoji();
      composeRef.current?.focusInput();
    },
    [closeEmoji, closeMessageMenu, peerDisplayName],
  );

  const handleDeleteMessage = useCallback(
    (messageUuid: string) => {
      closeMessageMenu();
      if (!conversationUuid) return;
      Alert.alert("Удалить сообщение?", "Сообщение исчезнет у обоих участников.", [
        { text: "Отмена", style: "cancel" },
        {
          text: "Удалить",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await apiDeleteMessage(conversationUuid, messageUuid);
                const queryKey = ["messages", conversationUuid, otherUserUuid || ""] as const;
                queryClient.setQueryData(
                  queryKey,
                  (old: { items: MsgMessageDto[]; nextCursor: string | null } | undefined) => {
                    if (!old) return old;
                    const items = old.items.filter((m) => m.messageUuid !== messageUuid);
                    messageThreadCache.set(conversationUuid, items);
                    return { ...old, items };
                  },
                );
                void queryClient.invalidateQueries({ queryKey: ["conversations"] });
              } catch (e) {
                Alert.alert(
                  "Ошибка",
                  e instanceof Error ? e.message : "Не удалось удалить сообщение.",
                );
              }
            })();
          },
        },
      ]);
    },
    [closeMessageMenu, conversationUuid, otherUserUuid, queryClient],
  );

  const dismissReportMessageModal = useCallback(() => {
    if (reportBusy) return;
    setPendingReportMessage(null);
    setReportError(null);
  }, [reportBusy]);

  const beginReportMessage = useCallback((message: ThreadBubbleItem) => {
    setReportError(null);
    setPendingReportMessage(message);
  }, []);

  const handleConfirmReportMessage = useCallback(
    async (category: FrankingReportCategory) => {
      const message = pendingReportMessage;
      const peer = otherUserUuid?.trim();
      const viewerUserUuid = me?.userUuid?.trim();
      const material = fscpMaterial;
      const dto = messages.find((row) => row.messageUuid === message?.messageUuid);
      const wire = dto?.encryptedPayload?.trim();
      if (!message || !peer || !viewerUserUuid || !material || !dto || !wire) return;
      setReportBusy(true);
      setReportError(null);
      try {
        await submitFrankingMessageReport({
          category,
          persistedMessageUuid: message.messageUuid,
          wire,
          viewerUserUuid,
          agreementPrivateKey: material.agreementPrivateKey,
          serverFrankReceipt: dto.serverFrankReceipt ?? null,
          frankTagBase64Url: dto.frankTagBase64Url ?? null,
          localMaterial: material,
        });
        setPendingReportMessage(null);
      } catch (e) {
        setReportError(frankingReportUserError(e));
      } finally {
        setReportBusy(false);
      }
    },
    [fscpMaterial, me?.userUuid, messages, otherUserUuid, pendingReportMessage],
  );

  const canReportThreadMessage = useCallback(
    (message: ThreadBubbleItem) => {
      const dto = messages.find((row) => row.messageUuid === message.messageUuid);
      return (
        Boolean(otherUserUuid) &&
        canReportMessage({
          isFromMe: message.isFromMe,
          isGroupChat,
          sendStatus: message.sendStatus,
          decryptState: message.decryptState,
          frankTagBase64Url: dto?.frankTagBase64Url,
          wire: dto?.encryptedPayload,
          hasServerFrankReceipt: Boolean(dto?.serverFrankReceipt),
        })
      );
    },
    [isGroupChat, messages, otherUserUuid],
  );

  /**
   * Обработчик тапа по пузырю обязан быть НАВСЕГДА стабильным: он уходит в
   * memo-пузыри как prop, и смена identity (клавиатура, замеры фида) вела к
   * перерисовке всей ленты. Живые значения читаются через ref в момент тапа.
   */
  const onMessagePressImplRef = useRef<
    (message: ThreadBubbleItem, anchor: BubbleAnchorRect) => void
  >(() => undefined);
  onMessagePressImplRef.current = (message, anchor) => {
    setMenuTarget((prev) => {
      if (prev) return null;
      const canDelete =
        !isGroupChat && message.isFromMe && message.sendStatus !== "sending";
      const canReport = canReportThreadMessage(message);
      const panelHeight = estimateMenuPanelHeight(message.isFromMe, canDelete, canReport);
      const allowBottomClamp = !keyboardOpen;
      const fit = lockMenuFit({
        visualTop: anchor.visualTop,
        visualBottom: anchor.visualBottom,
        pressWindowY: anchor.originY,
        feedTopY,
        feedBottomY,
        windowHeight,
        panelHeight,
        menuGap: floraMessages.bubbleMenuGap,
        feedInset: floraMessages.bubbleMenuFeedInset,
        allowBottomClamp,
      });
      return {
        message,
        anchor,
        placement: fit.placement,
        shiftY: fit.shiftY,
        panelHeight: panelHeight + MENU_ROW_HEIGHT_PX,
        feedTopY,
      };
    });
    closeEmoji();
    dismissKeyboard();
  };
  const onMessagePress = useCallback(
    (message: ThreadBubbleItem, anchor: BubbleAnchorRect) =>
      onMessagePressImplRef.current(message, anchor),
    [],
  );

  /**
   * Ключ trailing peer-run'а (у якоря) — отдельной строкой, а не чтением
   * listData внутри renderMessage: зависимость от всего массива меняла
   * identity renderItem на каждой волне расшифровки/доклейке окна, и
   * FlashList перерендеривал все смонтированные ячейки.
   */
  const trailingPeerGroupKey =
    listData[0]?.kind === "peer" ? listData[0].groupKey : null;

  const renderMessage = useCallback(
    ({ item }: { item: ThreadListItem }) => {
      if (__DEV__) noteChatOpenCellRender(conversationUuid);
      // Обратный переворот строки: лента перевёрнута целиком (см. listInverted).
      if (item.kind === "peer") {
        // Хвост trailing run'а (у якоря) — hold avatar на insertLift.
        const isTrailingTail = item.isGroupTail && item.groupKey === trailingPeerGroupKey;
        return (
          <View style={styles.rowInverted}>
            <ChatPeerMessageRow
              message={item.message}
              showAvatar={item.isGroupTail}
              peer={peer}
              groupMembers={isGroupChat ? groupThread.members : undefined}
              onPress={onMessagePress}
              holdAvatarStyle={isTrailingTail ? peerAvatarHoldStyle : undefined}
            />
          </View>
        );
      }

      const message = item.message;
      const clientKey = message.clientMessageKey ?? message.messageUuid;
      return (
        <View style={styles.rowInverted}>
          <ChatMessageBirthHost clientMessageKey={clientKey}>
            <ChatMessageBubble
              message={message}
              peer={peer}
              showPeerAvatar={false}
              isPeerIndented={false}
              onPress={onMessagePress}
            />
          </ChatMessageBirthHost>
        </View>
      );
    },
    [
      conversationUuid,
      groupThread.members,
      isGroupChat,
      onMessagePress,
      peer,
      peerAvatarHoldStyle,
      trailingPeerGroupKey,
    ],
  );

  const onPickImages = useCallback(async () => {
    if (!canSend()) return;
    const error = await pickImages();
    if (error) Alert.alert("Фото", error);
  }, [canSend, pickImages]);

  // Голосовой режим закрывает панель эмодзи (closeEmoji); клавиатуру явно не трогаем.
  // Инпут остаётся смонтированным и сфокусированным (ChatComposeField прячет его).
  const onStartVoice = useCallback(async () => {
    if (!canSend()) return;
    if (!isGroupChat && !otherUserUuid) return;
    typingEmitterRef.current?.stop();
    closeEmoji();
    enterVoiceMode();
    await voiceRecorder.start();
  }, [canSend, closeEmoji, enterVoiceMode, isGroupChat, otherUserUuid, voiceRecorder]);

  const onDiscardVoice = useCallback(async () => {
    await voiceRecorder.discard();
    clearVoiceDraft();
  }, [clearVoiceDraft, voiceRecorder]);

  const stopVoiceRef = useRef(voiceRecorder.stop);
  stopVoiceRef.current = voiceRecorder.stop;

  const onStopVoice = useCallback(() => {
    void stopVoiceRef.current();
  }, []);

  const onSendVoice = useCallback(async () => {
    if (!conversationUuid || !me?.userUuid || !voiceDraft) return;
    if (!isGroupChat && !otherUserUuid) return;
    if (!canSendVoice || voiceDraft.transcoding || voiceDraft.transcodeError) return;
    if (!canSend()) return;
    const material = useFscpStore.getState().material;
    if (!material) return;

    const sourceUri = voiceDraft.uri;
    const contentType = voiceDraft.contentType;
    const durationMs = voiceDraft.durationMs;
    const waveform = voiceDraft.waveform;
    const activeReply = replyTo;
    const clientMessageKey = floraNewUuid();
    const provisionalAssetUuid = floraNewUuid();

    registerPendingVoiceUri(provisionalAssetUuid, sourceUri);
    const optimisticBlocks: FscpMessageBlock[] = [
      provisionalVoiceBlock({
        assetUuid: provisionalAssetUuid,
        durationMs,
        waveform,
        contentType,
      }),
    ];

    typingEmitterRef.current?.stop();
    setSending(true);
    await voiceRecorder.discard();
    clearVoiceDraft();
    setReplyTo(null);
    setDeleteBarHeightPx(0);
    atBottomRef.current = true;

    if (isGroupChat) {
      try {
        const voiceBlock = await uploadPreparedMessageVoice({
          uploadTarget: { kind: "group", conversationUuid },
          sourceUri,
          contentType,
          durationMs,
          waveform,
        });
        registerPendingVoiceUri(voiceBlock.assetUuid, sourceUri);
        clearPendingVoiceUri(provisionalAssetUuid);
        const result = await groupThread.sendBlocks([voiceBlock], {
          voiceAssetUuids: [voiceBlock.assetUuid],
          replyTo: activeReply ?? undefined,
          onPending: (key) => {
            seenMessageIdsRef.current.add(key);
            pinListToBottom(false);
            playChatListInsertLift(insertLiftSv, estimateBlocksInsertLiftPx([voiceBlock], outgoingLiftCtx));
          },
        });
        if (result.ok) seenMessageIdsRef.current.add(result.clientMessageKey);
      } catch (err) {
        clearPendingVoiceUri(provisionalAssetUuid);
        const message = err instanceof Error ? err.message : "Не удалось отправить голосовое";
        Alert.alert("Отправка", message);
      } finally {
        setSending(false);
      }
      return;
    }

    insertOptimisticOutgoingThreadMessage({
      queryClient,
      conversationUuid,
      otherUserUuid: otherUserUuid!,
      senderUserUuid: me.userUuid,
      clientMessageKey,
      blocks: optimisticBlocks,
      replyTo: activeReply ?? undefined,
    });
    seenMessageIdsRef.current.add(clientMessageKey);
    pinListToBottom(false);
    playChatListInsertLift(insertLiftSv, estimateBlocksInsertLiftPx(optimisticBlocks, outgoingLiftCtx));

    try {
      const peerKey = await apiGetUserE2ePublicKey(otherUserUuid!);
      if (!peerKey.publicKeyBase64) throw new Error("У собеседника нет E2E-ключа");

      const voiceBlock = await uploadPreparedMessageVoice({
        toUserUuid: otherUserUuid!,
        sourceUri,
        contentType,
        durationMs,
        waveform,
      });

      registerPendingVoiceUri(voiceBlock.assetUuid, sourceUri);
      clearPendingVoiceUri(provisionalAssetUuid);

      const wire = await buildBlocksMessageWire({
        senderUserUuid: me.userUuid,
        receiverUserUuid: otherUserUuid!,
        material,
        receiverAgreementPublicKeyBase64: peerKey.publicKeyBase64,
        blocks: [voiceBlock],
        replyTo: activeReply ?? undefined,
      });
      const encryptedPushPreviews = await buildEncryptedPushPreviews({
        wire,
        recipientUserUuid: otherUserUuid!,
        senderSigningPrivateKey: material.signingPrivateKey,
        blocks: [voiceBlock],
      });
      const sent = await sendTextMessage({
        conversationUuid,
        wire,
        attachments: { voiceAssetUuids: [voiceBlock.assetUuid] },
        encryptedPushPreviews,
      });
      replaceOptimisticOutgoingThreadMessage({
        queryClient,
        conversationUuid,
        otherUserUuid: otherUserUuid!,
        senderUserUuid: me.userUuid,
        clientMessageKey,
        sent,
        wire,
        blocks: [voiceBlock],
        replyTo: activeReply ?? undefined,
      });
      seenMessageIdsRef.current.add(sent.messageUuid);
      setMenuTarget((prev) => {
        if (!prev || prev.message.messageUuid !== clientMessageKey) return prev;
        return {
          ...prev,
          message: {
            ...prev.message,
            messageUuid: sent.messageUuid,
            clientMessageKey,
            sendStatus: undefined,
          },
        };
      });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      removeOptimisticOutgoingThreadMessage({
        queryClient,
        conversationUuid,
        otherUserUuid: otherUserUuid!,
        clientMessageKey,
      });
      clearPendingVoiceUri(provisionalAssetUuid);
      const message = err instanceof Error ? err.message : "Не удалось отправить голосовое";
      Alert.alert("Отправка", message);
    } finally {
      setSending(false);
    }
  }, [
    canSend,
    canSendVoice,
    clearVoiceDraft,
    conversationUuid,
    groupThread,
    isGroupChat,
    me?.userUuid,
    otherUserUuid,
    outgoingLiftCtx,
    pinListToBottom,
    queryClient,
    replyTo,
    setDeleteBarHeightPx,
    insertLiftSv,
    voiceDraft,
    voiceRecorder,
  ]);

  useEffect(() => {
    if (isGroupChat || !conversationUuid || !otherUserUuid) {
      typingEmitterRef.current?.dispose();
      typingEmitterRef.current = null;
      return undefined;
    }
    const conv = conversationUuid;
    const other = otherUserUuid;
    const emitter = createTypingEmitter({
      postTyping: (isTyping) => apiPostTyping(conv, isTyping, other),
      onTrueHeartbeat: () => {
        if (AppState.currentState !== "active") return;
        return apiPresenceHeartbeat();
      },
    });
    typingEmitterRef.current?.dispose();
    typingEmitterRef.current = emitter;
    return () => {
      emitter.dispose();
      if (typingEmitterRef.current === emitter) typingEmitterRef.current = null;
    };
  }, [conversationUuid, isGroupChat, otherUserUuid]);

  useEffect(() => {
    if (voiceMode === "voice") {
      typingEmitterRef.current?.stop();
    }
  }, [voiceMode]);

  const onComposeTextChange = useCallback((text: string) => {
    typingEmitterRef.current?.onText(text);
  }, []);

  const onSend = async (draft: string) => {
    const trimmed = draft.trim();

    if (isGroupChat) {
      if (!conversationUuid || !me?.userUuid) return;
      if (!trimmed && composeImages.length === 0) return;
      if (!canSend() || !useFscpStore.getState().material) {
        setUnlockOpen(true);
        Alert.alert(
          "Шифрование",
          "Нужно разблокировать ключи шифрования, чтобы писать в группу.",
        );
        return;
      }
      const imageSnapshot = composeImages.map((image) => ({
        uri: image.uri,
        contentType: image.contentType,
      }));
      const activeReply = replyTo;
      setSending(true);
      setReplyTo(null);
      setDeleteBarHeightPx(0);
      atBottomRef.current = true;
      composeRef.current?.clearText();
      clearImages();
      try {
        if (imageSnapshot.length === 0) {
          const result = await groupThread.sendText(trimmed, {
            replyTo: activeReply ?? undefined,
            onPending: (clientMessageKey) => {
              seenMessageIdsRef.current.add(clientMessageKey);
              pinListToBottom(false);
              playChatListInsertLift(
                insertLiftSv,
                estimateBlocksInsertLiftPx([{ kind: "text", body: trimmed }], outgoingLiftCtx),
              );
            },
          });
          if (!result.ok && result.restoreDraft) {
            composeRef.current?.setText(trimmed);
          }
          return;
        }
        const blocks: FscpMessageBlock[] = [];
        const imageAssetUuids: string[] = [];
        if (trimmed) blocks.push({ kind: "text", body: trimmed });
        for (const image of imageSnapshot) {
          const uploaded = await uploadPreparedMessageImage({
            uploadTarget: { kind: "group", conversationUuid },
            prepared: {
              uri: image.uri,
              contentType: image.contentType,
              fileName: "photo.jpg",
            },
          });
          seedMessageImageUri(uploaded.assetUuid, image.uri);
          blocks.push(uploaded);
          imageAssetUuids.push(uploaded.assetUuid);
        }
        if (blocks.length === 0) return;
        const result = await groupThread.sendBlocks(blocks, {
          imageAssetUuids,
          replyTo: activeReply ?? undefined,
          onPending: (clientMessageKey) => {
            seenMessageIdsRef.current.add(clientMessageKey);
            pinListToBottom(false);
            playChatListInsertLift(insertLiftSv, estimateBlocksInsertLiftPx(blocks, outgoingLiftCtx));
          },
        });
        if (!result.ok && result.restoreDraft) {
          composeRef.current?.setText(trimmed);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Не удалось отправить сообщение";
        Alert.alert("Отправка", message);
        if (trimmed) composeRef.current?.setText(trimmed);
      } finally {
        setSending(false);
      }
      return;
    }

    if (!conversationUuid || !me?.userUuid || !otherUserUuid) return;
    if (!trimmed && composeImages.length === 0) return;
    if (!canSend() || hasPendingPrepare) return;
    const material = useFscpStore.getState().material;
    if (!material) return;

    const imageSnapshot = composeImages.map((image) => ({
      uri: image.uri,
      contentType: image.contentType,
    }));
    const activeReply = replyTo;
    const clientMessageKey = floraNewUuid();

    const optimisticBlocks: FscpMessageBlock[] = [];
    if (trimmed) optimisticBlocks.push({ kind: "text", body: trimmed });
    for (const image of imageSnapshot) {
      const provisionalId = floraNewUuid();
      seedMessageImageUri(provisionalId, image.uri);
      optimisticBlocks.push(provisionalImageBlock(provisionalId, image.contentType));
    }
    if (optimisticBlocks.length === 0) return;

    typingEmitterRef.current?.stop();
    setSending(true);
    composeRef.current?.clearText();
    clearImages();
    setReplyTo(null);
    setDeleteBarHeightPx(0);
    atBottomRef.current = true;

    insertOptimisticOutgoingThreadMessage({
      queryClient,
      conversationUuid,
      otherUserUuid,
      senderUserUuid: me.userUuid,
      clientMessageKey,
      blocks: optimisticBlocks,
      replyTo: activeReply ?? undefined,
    });
    seenMessageIdsRef.current.add(clientMessageKey);
    pinListToBottom(false);
    playChatListInsertLift(insertLiftSv, estimateBlocksInsertLiftPx(optimisticBlocks, outgoingLiftCtx));

    try {
      const peerKey = await apiGetUserE2ePublicKey(otherUserUuid);
      if (!peerKey.publicKeyBase64) throw new Error("У собеседника нет E2E-ключа");

      const blocks: FscpMessageBlock[] = [];
      const imageAssetUuids: string[] = [];
      if (trimmed) blocks.push({ kind: "text", body: trimmed });
      for (let i = 0; i < imageSnapshot.length; i++) {
        const image = imageSnapshot[i]!;
        const uploaded = await uploadPreparedMessageImage({
          toUserUuid: otherUserUuid,
          prepared: {
            uri: image.uri,
            contentType: image.contentType,
            fileName: "photo.jpg",
          },
        });
        seedMessageImageUri(uploaded.assetUuid, image.uri);
        blocks.push(uploaded);
        imageAssetUuids.push(uploaded.assetUuid);
      }
      if (blocks.length === 0) {
        removeOptimisticOutgoingThreadMessage({
          queryClient,
          conversationUuid,
          otherUserUuid,
          clientMessageKey,
        });
        return;
      }

      const wire = await buildBlocksMessageWire({
        senderUserUuid: me.userUuid,
        receiverUserUuid: otherUserUuid,
        material,
        receiverAgreementPublicKeyBase64: peerKey.publicKeyBase64,
        blocks,
        replyTo: activeReply ?? undefined,
      });
      const encryptedPushPreviews = await buildEncryptedPushPreviews({
        wire,
        recipientUserUuid: otherUserUuid,
        senderSigningPrivateKey: material.signingPrivateKey,
        blocks,
      });
      const sent = await sendTextMessage({
        conversationUuid,
        wire,
        attachments: imageAssetUuids.length > 0 ? { imageAssetUuids } : undefined,
        encryptedPushPreviews,
      });
      replaceOptimisticOutgoingThreadMessage({
        queryClient,
        conversationUuid,
        otherUserUuid,
        senderUserUuid: me.userUuid,
        clientMessageKey,
        sent,
        wire,
        blocks,
        replyTo: activeReply ?? undefined,
      });
      seenMessageIdsRef.current.add(sent.messageUuid);
      setMenuTarget((prev) => {
        if (!prev || prev.message.messageUuid !== clientMessageKey) return prev;
        return {
          ...prev,
          message: {
            ...prev.message,
            messageUuid: sent.messageUuid,
            clientMessageKey,
            sendStatus: undefined,
          },
        };
      });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      removeOptimisticOutgoingThreadMessage({
        queryClient,
        conversationUuid,
        otherUserUuid,
        clientMessageKey,
      });
      const message = err instanceof Error ? err.message : "Не удалось отправить сообщение";
      Alert.alert("Отправка", message);
    } finally {
      setSending(false);
    }
  };

  const blocked = !fscpReady;
  const blockedText =
    fscpStatus === "backup_not_found"
      ? "Резервная копия ключей не найдена. Войдите с паролем на вебе, затем нажмите, чтобы повторить."
      : fscpStatus === "key_mismatch"
        ? "Ключи не совпадают с аккаунтом. Нажмите, чтобы восстановить паролем."
        : "Расшифровка недоступна. Нажмите, чтобы ввести пароль и восстановить ключи.";
  const decryptFailHint =
    "Не удалось расшифровать. Нажмите, чтобы ввести пароль и восстановить ключи.";
  const insertEmoji = useCallback((emoji: string) => {
    composeRef.current?.insertToken(emoji);
  }, []);

  /** Хвост-заглушка под доком: idle-подъём на navInset не должен оголять ленту. */
  const dockTailHeightPx = -keyboardStickyOffsets(systemNavBottomInset).closed;

  const composeBottomInset =
    Platform.OS === "android"
      ? 0
      : composeDockActive
        ? 0
        : systemNavBottomInset;

  return (
    <View style={styles.root}>
      <MessageBubbleMoreMenu
        open={menuTarget != null}
        targetUuid={menuTarget?.message.messageUuid ?? null}
        anchor={menuTarget?.anchor ?? null}
        placement={menuTarget?.placement ?? "above"}
        shiftY={menuTarget?.shiftY ?? 0}
        visualTop={menuTarget?.anchor.visualTop ?? null}
        feedTopY={menuTarget?.feedTopY ?? null}
        panelHeight={menuTarget?.panelHeight ?? 0}
        menuGap={floraMessages.bubbleMenuGap}
        feedInset={floraMessages.bubbleMenuFeedInset}
        isFromMe={menuTarget?.message.isFromMe ?? false}
        canReplyCopy={
          menuTarget != null &&
          menuTarget.message.decryptState === "ok" &&
          menuTarget.message.previewText.length > 0
        }
        canReply={canReplyToMessage(menuTarget?.message)}
        canDelete={
          !isGroupChat &&
          menuTarget != null &&
          menuTarget.message.isFromMe &&
          menuTarget.message.sendStatus !== "sending"
        }
        onClose={closeMessageMenu}
        onReply={
          menuTarget ? () => beginReplyToMessage(menuTarget.message) : undefined
        }
        onCopy={
          menuTarget
            ? () => void copyMessageContent(menuTarget.message.previewText)
            : undefined
        }
        onDelete={
          !isGroupChat && menuTarget?.message.isFromMe
            ? () => handleDeleteMessage(menuTarget.message.messageUuid)
            : undefined
        }
        onReport={
          menuTarget && canReportThreadMessage(menuTarget.message)
            ? () => beginReportMessage(menuTarget.message)
            : undefined
        }
      >
      <View
        ref={chatHeaderWrapRef}
        collapsable={false}
        style={menuTarget != null ? styles.chromeDismissHost : undefined}
      >
        {isGroupChat ? (
          <ChatGroupThreadHeader
            title={groupThread.title}
            conversationUuid={conversationUuid}
            memberCount={groupThread.memberCount}
            onMembersPress={() => {
              dismissKeyboard();
              groupThread.setMembersOpen(true);
            }}
            onMorePress={() => setMoreMenuOpen((open) => !open)}
            moreMenuOpen={moreMenuOpen}
            moreButtonRef={moreBtnRef}
          />
        ) : (
          <ChatThreadHeader
            peer={peer}
            moreButtonRef={moreBtnRef}
            moreMenuOpen={moreMenuOpen}
            onMorePress={() => setMoreMenuOpen((open) => !open)}
          />
        )}
        {menuTarget != null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть меню"
            style={styles.chromeDismissFill}
            onPress={closeMessageMenu}
          />
        ) : null}
      </View>

      <View style={menuTarget != null ? styles.chromeDismissHost : undefined}>
      {blocked ? (
        <Pressable style={styles.blockedBanner} onPress={() => setUnlockOpen(true)}>
          <Text style={styles.blockedText}>{blockedText}</Text>
        </Pressable>
      ) : null}

      {!blocked && hasDecryptFailures ? (
        <Pressable style={styles.blockedBanner} onPress={() => setUnlockOpen(true)}>
          <Text style={styles.blockedText}>{decryptFailHint}</Text>
        </Pressable>
      ) : null}
        {menuTarget != null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть меню"
            style={styles.chromeDismissFill}
            onPress={closeMessageMenu}
          />
        ) : null}
      </View>

      <KeyboardGestureArea
        style={styles.chatBody}
        interpolator="ios"
        textInputNativeID="chat-compose-input"
        offset={kgaOffsetPx}
      >
      <View style={styles.messagesArea}>
        {/*
          Заглушка — отдельный слой под лентой, а не `ListEmptyComponent`: иначе
          пустой FlashList занимает всю раскладку, и между спиннером и контентом
          зияет промежуток. Opacity переключается мгновенно, без кроссфейда.
        */}
        <Reanimated.View
          pointerEvents="none"
          style={[
            styles.listFill,
            styles.listPlaceholder,
            listPlaceholderStyle,
            // Тот же коммит, что показывает ленту, гасит заглушку: подмена
            // атомарна, без кадра «обе прозрачны» между SV и состоянием.
            listRevealed ? styles.listHiddenUntilReveal : null,
          ]}
        >
          {/* count>0 — лента домеряется невидимо: держим пустой фон, как
              Telegram; спиннер только когда данных ещё реально нет. */}
          {listPending ? (
            <>
              <ActivityIndicator color={floraColors.greenLight} />
              <Text style={styles.emptyText}>Загрузка сообщений…</Text>
            </>
          ) : listMessageCount > 0 ? null : (
            <Text style={styles.emptyText}>
              {blocked ? "Расшифровка недоступна" : "Напишите первое сообщение"}
            </Text>
          )}
        </Reanimated.View>

        {/*
          Видимость ленты — React-состояние, НЕ animated style. Анимированный
          opacity применялся с UI-потока, а следующий React-коммит возвращал
          запечённый начальный opacity:0 из useAnimatedStyle — лента гасла
          через кадр после показа и не возвращалась до реального жеста
          («редкое мигание» на первом открытии группы). Закоммиченный через
          состояние opacity стабилен к любым последующим коммитам.
        */}
        <Reanimated.View
          style={[
            styles.listFill,
            listRevealed ? null : styles.listHiddenUntilReveal,
            listLiftStyle,
          ]}
        >
          {/* insertLift: тот же transform для ленты и нового пузыря (без отдельного bubble translate). */}
          <Reanimated.View style={[styles.listFill, listInsertLiftStyle]}>
            <FlashList
              key={conversationUuid}
              data={listDataWindow}
              keyExtractor={listItemKey}
              getItemType={messageItemType}
              style={styles.listInverted}
              contentContainerStyle={listContentStyle}
              renderScrollComponent={renderScrollComponent}
              onScroll={onScroll}
              onScrollBeginDrag={onScrollBeginDrag}
              scrollEventThrottle={16}
              // always: иначе первый тап по play только закрывает клавиатуру.
              keyboardShouldPersistTaps="always"
              // Строки чата выше дефолтных 250 px (коллаж — до 470), из-за чего
              // соседние ячейки размонтируются прямо у края вьюпорта.
              drawDistance={480}
              /*
                `startRenderingFromBottom` тут больше не нужен и вреден: он прижимал
                короткий тред к низу отступом `windowSize - childContainerSize`,
                который уменьшался ступенями по мере домера строк — лента ехала
                вверх, и офсетом это не лечилось. У перевёрнутой ленты короткий тред
                стоит у низа по построению. Автоподстройка позиции тоже не нужна:
                новое сообщение приходит в начало данных, то есть ровно туда, где
                стоит скролл, и попадает в кадр само.
              */
              maintainVisibleContentPosition={{ disabled: true }}
              CellRendererComponent={MenuCellRenderer}
              // Показ ленты ждёт onLoad: каждая видимая строка замерена.
              onLoad={onFlashListLoad}
              // …и тишины лэйаута: пара кадров без изменений размера контента,
              // чтобы поздние коррекции высот не двигали уже видимые пузыри.
              onContentSizeChange={onListContentSizeChange}
              overrideProps={LIST_INITIAL_DRAW}
              renderItem={renderMessage}
            />
          </Reanimated.View>
        </Reanimated.View>

        {showJumpToLatest ? (
          <Reanimated.View
            style={[styles.jumpBtn, jumpBtnBottomStyle]}
            pointerEvents={menuTarget != null ? "box-none" : "auto"}
          >
            <Pressable onPress={() => scrollToEnd(true)}>
              <Text style={styles.jumpBtnText}>Новые сообщения</Text>
            </Pressable>
            {menuTarget != null ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Закрыть меню"
                style={styles.chromeDismissFill}
                onPress={closeMessageMenu}
              />
            ) : null}
          </Reanimated.View>
        ) : null}
      </View>

      <Reanimated.View
        ref={dockFooterRef}
        collapsable={false}
        style={[styles.dockFooter, dockStickyStyle]}
      >
        <View
          style={styles.dockColumn}
          onLayout={(e) => onDockColumnIdleLayout(e.nativeEvent.layout.height)}
        >
          {replyTo ? (
            <ChatComposeReplyBar
              reply={replyTo}
              onDismiss={clearReplyDraft}
              onLayout={(height) => setDeleteBarHeightPx(height)}
            />
          ) : null}

          <ChatComposeField
            ref={composeRef}
            onSend={(draft) => void onSend(draft)}
            sending={sending}
            disabled={!canSend() || (!isGroupChat && !otherUserUuid)}
            /* EditText — вне критического пути открытия: до показа ленты поле
               живёт фасадом (инпут absolute и в layout не участвует), тап по
               нему монтирует и фокусирует. Latch внутри — при переключении
               чатов инпут уже смонтирован, повторной цены нет. */
            mountInput={listRevealed}
            placeholder={blocked ? "Отправка недоступна" : "Сообщение"}
            bottomInset={composeBottomInset}
            onShellLayout={onComposeShellLayout}
            growthHoldSv={composeGrowthHoldSv}
            emojiAccessoryActive={emojiAccessoryActive}
            onToggleEmoji={() =>
              toggleEmoji(() => composeRef.current?.showInputKeyboard())
            }
            onTextChange={onComposeTextChange}
            images={composeImages}
            onRemoveImageAt={removeImageAt}
            onPickImages={() => void onPickImages()}
            hasPendingImages={hasPendingPrepare}
            voiceMode={voiceMode === "voice"}
            voiceRecording={voiceRecorder.recording}
            voiceShowStopControl={voiceRecorder.showStopControl}
            voiceRecordingStartedAt={voiceRecorder.recordingStartedAt}
            voiceWaveform={voiceDraft?.waveform ?? []}
            voiceTranscoding={voiceDraft?.transcoding ?? false}
            voiceCanSend={canSendVoice}
            onStartVoice={() => void onStartVoice()}
            onDiscardVoice={() => void onDiscardVoice()}
            onStopVoice={onStopVoice}
            onSendVoice={() => void onSendVoice()}
          />

        </View>

        {menuTarget != null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть меню"
            style={styles.chromeDismissFill}
            onPress={closeMessageMenu}
          />
        ) : null}

        {/* При смонтированной панели полосу navInset закрывает статичная
            шторка (см. emojiNavShutter): хвост едет с доком и при открытой
            панели перекрыл бы её верх (z дока выше). Подмена одноимённой
            полосы происходит в одном коммите — попиксельно незаметна. */}
        {dockTailHeightPx > 0 && !emojiPanelMounted ? (
          <View style={[styles.dockTail, { height: dockTailHeightPx }]} />
        ) : null}
      </Reanimated.View>

      {emojiPanelMounted ? (
        /* Панель — фиксированный слой у низа экрана (top: 100% контейнера),
           едет тем же transform-ом, что и док: верх слоя всегда совпадает с
           нижней гранью дока, layout считается один раз при маунте.
           +navInset к высоте: нижняя полоса подложки доводит фон до низа окна
           при полностью открытой панели. */
        <Reanimated.View
          style={[
            styles.emojiPanelUnderlay,
            { height: emojiPanelHeightPx + dockTailHeightPx },
            emojiPanelLayerStyle,
          ]}
        >
          <View style={[styles.emojiPanelFixed, { height: emojiPanelHeightPx }]}>
            <View style={styles.emojiPanelCard}>
              {/* Тяжёлый контент — после осадки дока: React-коммит грида не
                  должен попадать в кадры transform-анимации (источник рывков). */}
              {emojiPanelReady ? <ChatMessageEmojiPanel onPickEmoji={insertEmoji} /> : null}
            </View>
          </View>
        </Reanimated.View>
      ) : null}

      {emojiPanelMounted && dockTailHeightPx > 0 ? (
        /* Статичная шторка nav-зоны (z между панелью и доком): в покое слой
           панели выглядывал бы из-за нижней грани на navInset (там transform
           дока даёт зазор) — шторка прячет его до старта анимации и превращает
           закрытие в уход карточки за край. При открытой панели она же —
           пустая полоса над системной навигацией (как у IME). */
        <View
          pointerEvents="none"
          style={[styles.emojiNavShutter, { height: dockTailHeightPx }]}
        />
      ) : null}
      </KeyboardGestureArea>
      </MessageBubbleMoreMenu>

      <ChatMoreMenu
        open={moreMenuOpen}
        onClose={() => setMoreMenuOpen(false)}
        anchorRef={moreBtnRef}
        kind={isGroupChat ? "groupChat" : "dm"}
        isMuted={conversationMuted}
        isArchived={isGroupChat ? groupIsArchived : false}
        onMuteForever={() => {
          if (otherUserUuid && conversationUuid) {
            clearTemporaryMute(otherUserUuid);
            void setMuted(otherUserUuid, conversationUuid, true);
          }
        }}
        onMuteTemporary={() => {
          if (otherUserUuid && conversationUuid) {
            setTemporaryMute(otherUserUuid);
            void setMuted(otherUserUuid, conversationUuid, true);
          }
        }}
        onUnmute={() => {
          if (otherUserUuid && conversationUuid) {
            clearTemporaryMute(otherUserUuid);
            void setMuted(otherUserUuid, conversationUuid, false);
          }
        }}
        onArchive={
          isGroupChat
            ? () => {
                if (!organizerKeysReady) {
                  setUnlockOpen(true);
                  return;
                }
                if (!canArchivePeer) {
                  Alert.alert(
                    "Лимит папок",
                    "Нельзя архивировать: уже заняты все четыре слота иконок. Удалите папку, чтобы освободить место для Архива.",
                  );
                  return;
                }
                void (async () => {
                  const ok = await setGroupArchived(conversationUuid, true);
                  if (!ok) {
                    Alert.alert(
                      "Лимит папок",
                      "Нельзя архивировать: уже заняты все четыре слота иконок. Удалите папку, чтобы освободить место для Архива.",
                    );
                    return;
                  }
                  requestTabBadgesRefresh();
                  router.back();
                })();
              }
            : undefined
        }
        onUnarchive={
          isGroupChat
            ? () => {
                if (!organizerKeysReady) {
                  setUnlockOpen(true);
                  return;
                }
                void (async () => {
                  await setGroupArchived(conversationUuid, false);
                  requestTabBadgesRefresh();
                })();
              }
            : undefined
        }
        onDelete={() => {
          if (isGroupChat) {
            groupThread.leaveGroup();
            return;
          }
          if (!conversationUuid) return;
          const peerName = peer.otherDisplayName || peer.otherUsername || "пользователем";
          Alert.alert("Удалить чат?", `Чат с ${peerName} будет удалён.`, [
            { text: "Отмена", style: "cancel" },
            {
              text: "Удалить",
              style: "destructive",
              onPress: () => {
                void (async () => {
                  try {
                    await apiDeleteConversation(conversationUuid, peer.otherUserUuid);
                    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
                    router.back();
                  } catch {
                    Alert.alert("Не удалось удалить чат", "Попробуйте ещё раз.");
                  }
                })();
              },
            },
          ]);
        }}
      />

      {isGroupChat ? (
        <GroupMembersSheet
          open={groupThread.membersOpen}
          title={groupThread.title}
          members={groupThread.members}
          meUserUuid={me?.userUuid ?? ""}
          isCreator={groupThread.isCreator}
          addCandidates={groupThread.addCandidates}
          busy={groupThread.membersBusy}
          error={groupThread.membersError}
          onClose={() => groupThread.setMembersOpen(false)}
          onSaveTitle={groupThread.isCreator ? groupThread.saveTitle : undefined}
          onRemoveMember={groupThread.isCreator ? groupThread.removeMember : undefined}
          onAddMember={groupThread.isCreator ? groupThread.addMember : undefined}
        />
      ) : null}

      <FscpUnlockSheet
        visible={unlockOpen}
        userUuid={me?.userUuid ?? null}
        onClose={() => setUnlockOpen(false)}
      />

      <ChatReportMessageModal
        visible={pendingReportMessage != null}
        busy={reportBusy}
        error={reportError}
        onDismiss={dismissReportMessageModal}
        onConfirm={(category) => void handleConfirmReportMessage(category)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: floraColors.bg,
  },
  blockedBanner: {
    backgroundColor: "rgba(255, 180, 60, 0.12)",
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid,
    marginHorizontal: floraSpacing.grid,
    borderRadius: 8,
  },
  blockedText: {
    color: floraColors.text,
    fontSize: 13,
    lineHeight: 18,
  },
  chromeDismissHost: {
    position: "relative",
  },
  chromeDismissFill: {
    ...StyleSheet.absoluteFill,
    zIndex: 6,
  },
  menuCellDismiss: {
    ...StyleSheet.absoluteFill,
    zIndex: 1,
  },
  chatBody: {
    flex: 1,
    minHeight: 0,
  },
  messagesArea: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    // Лента поднимается transform-ом: без клипа поднятый вьюпорт рисуется поверх шапки.
    overflow: "hidden",
  },
  listFill: {
    ...StyleSheet.absoluteFill,
    overflow: "visible",
  },
  /** До показа лента (или после показа — заглушка) прозрачна: см. listRevealed. */
  listHiddenUntilReveal: {
    opacity: 0,
  },
  /**
   * Переворот ленты целиком: последнее сообщение оказывается в начале скролла,
   * то есть «внизу» — это константный офсет, а не считаемый из высот предел.
   */
  listInverted: {
    ...StyleSheet.absoluteFill,
    transform: [{ scaleY: -1 }],
    overflow: "visible",
  },
  rowInverted: {
    transform: [{ scaleY: -1 }],
    overflow: "visible",
  },
  rowMenuOpen: {
    zIndex: 8,
    elevation: 8,
  },
  menuCell: {
    overflow: "visible",
  },
  menuCellOpen: {
    zIndex: 20,
    elevation: 20,
  },
  /**
   * Док — absolute-оверлей у низа: рост слота не влияет на layout ленты
   * (зазор под доком несёт paddingTop контент-контейнера, см. listContentStyle),
   * двигается transform-ом.
   */
  dockFooter: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    elevation: 20,
    backgroundColor: floraColors.bg,
  },
  dockColumn: {
    backgroundColor: floraColors.bg,
  },
  /** Заглушка под доком: закрывает полосу navInset при idle-подъёме (Android). */
  dockTail: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    backgroundColor: floraColors.bg,
  },
  /**
   * Слой панели: сиблинг дока, верх на нижней грани контейнера чата (top:100%),
   * двигается тем же transform-ом, что и док. z ниже дока, выше ленты.
   */
  emojiPanelUnderlay: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    zIndex: 15,
    elevation: 15,
    backgroundColor: floraColors.bg,
  },
  /** Фиксированный слой панели: высота = panelTarget, лэйаутится один раз. */
  emojiPanelFixed: {
    ...emojiPanelChromePadding,
  },
  /** Статичная шторка nav-зоны при смонтированной панели (z: панель < шторка < док). */
  emojiNavShutter: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 18,
    elevation: 18,
    backgroundColor: floraColors.bg,
  },
  emojiPanelCard: {
    flex: 1,
    borderRadius: floraMessages.emojiPanelRadius,
    borderWidth: 1,
    borderColor: floraMessages.composeBorderColor,
    overflow: "hidden",
    backgroundColor: floraColors.surfaceElevated,
  },
  listPlaceholder: {
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingTop: floraMessages.bubbleRowGap + floraSpacing.grid * 4,
  },
  emptyText: {
    color: floraColors.gray,
    textAlign: "center",
    marginTop: floraSpacing.grid * 4,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  jumpBtn: {
    position: "absolute",
    alignSelf: "center",
    zIndex: 10,
    elevation: 10,
    backgroundColor: floraColors.greenDark,
    borderRadius: 16,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    borderWidth: 1,
    borderColor: floraMessages.composeBorderColor,
  },
  jumpBtnText: {
    color: floraColors.greenLight,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
});
