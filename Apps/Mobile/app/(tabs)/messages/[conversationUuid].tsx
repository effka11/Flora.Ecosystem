import {
  apiGetConversations,
  apiGetMessages,
  apiMarkConversationRead,
  apiArchiveConversation,
  apiMuteConversation,
  apiDeleteMessage,
  apiGetPushPreviewTargets,
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
import type { MsgConversationDto, MsgMessageDto } from "@flora/client-core/contracts";
import { apiPostTyping, apiPresenceHeartbeat, PRESENCE_TYPING_DEBOUNCE_MS } from "@flora/client-core/presence";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  InteractionManager,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  Alert,
  type ScrollViewProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardGestureArea } from "react-native-keyboard-controller";
import Reanimated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";
import {
  estimateBlocksInsertLiftPx,
  estimateRowInsertLiftPx,
  playChatListInsertLift,
} from "@/lib/chatListInsertLift";
import {
  buildThreadListItems,
  shouldHoldTrailingPeerAvatar,
  forEachThreadListMessage,
  type ThreadListItem,
} from "@/lib/threadMessageGroups";
import {
  ChatComposeField,
  type ChatComposeFieldHandle,
} from "@/components/messages/ChatComposeField";
import { ChatComposeReplyBar } from "@/components/messages/ChatComposeReplyBar";
import { ChatMessageBubble, type ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import { ChatPeerMessageGroup } from "@/components/messages/ChatPeerMessageGroup";
import { ChatMessageEmojiPanel } from "@/components/messages/ChatMessageEmojiPanel";
import { ChatMoreMenu } from "@/components/messages/ChatMoreMenu";
import {
  MessageBubbleMoreMenu,
  bubbleAnchorsEqual,
  type BubbleAnchorRect,
} from "@/components/messages/MessageBubbleMoreMenu";
import { ChatThreadHeader, type ChatPeerInfo } from "@/components/messages/ChatThreadHeader";
import {
  floraColors,
  floraMessages,
  floraNativeStackOptions,
  floraSpacing,
} from "@/lib/theme";
import { applyMessagesTabBarHidden } from "@/lib/messagesTabBar";
import { setActiveMessageThread } from "@/lib/activeMessageThread";
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
  removeOptimisticOutgoingThreadMessage,
  replaceOptimisticOutgoingThreadMessage,
} from "@/lib/messageThreadOutgoing";
import { replyDraftFromMessage, type MessageReplyDraft } from "@/lib/messageReply";
import { uploadPreparedMessageVoice } from "@/lib/messageVoiceAssets";
import {
  clearPendingVoiceUri,
  registerPendingVoiceUri,
} from "@/lib/pendingVoiceOutgoing";
import { useMessageComposeImages } from "@/lib/useMessageComposeImages";
import { useMessageComposeVoice } from "@/lib/useMessageComposeVoice";
import { useVoiceRecorder } from "@/lib/useVoiceRecorder";
import { useThreadMessageDecrypt } from "@/lib/useThreadMessageDecrypt";
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
 * Coarse recycle pools: voice, photo, text и peer-group имеют разный subtree.
 */
const messageItemType = (item: ThreadListItem): string => {
  if (item.kind === "peerGroup") return "peerGroup";
  const message = item.message;
  return message.voiceBlock ? "voice" : message.imageBlocks.length > 0 ? "photo" : "text";
};

function listItemKey(item: ThreadListItem): string {
  if (item.kind === "peerGroup") return `peer-${item.groupKey}`;
  return item.message.clientMessageKey ?? item.message.messageUuid;
}

export default function ThreadScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const tabBarBottomInset = Math.max(insets.bottom, 8);
  const systemNavBottomInset = resolveMessagesDockBottomInset(insets);

  const {
    dockStickyStyle,
    emojiPanelLayerStyle,
    jumpBtnBottomStyle,
    dockExtraPaddingSv,
    freezeListSv,
    listAnimatedRef,
    pinListToBottom,
    setListPinned,
    listRevealStyle,
    listLiftStyle,
    listPlaceholderStyle,
    hideListUntilReady,
    allowListReveal,
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
  const dockFooterRef = useRef<View>(null);
  const chatHeaderWrapRef = useRef<View>(null);
  const atBottomRef = useRef(true);
  const prevListLengthRef = useRef(0);
  const [menuTarget, setMenuTarget] = useState<{
    message: ThreadBubbleItem;
    anchor: BubbleAnchorRect;
  } | null>(null);
  const [feedTopY, setFeedTopY] = useState<number | null>(null);
  const [feedBottomY, setFeedBottomY] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<MessageReplyDraft | null>(null);

  const closeMessageMenu = useCallback(() => {
    setMenuTarget(null);
    setFeedTopY(null);
    setFeedBottomY(null);
  }, []);

  const syncFeedBoundsY = useCallback(() => {
    dockFooterRef.current?.measureInWindow((_dockX, dockY) => {
      chatHeaderWrapRef.current?.measureInWindow((_headerX, headerY, _headerW, headerH) => {
        const dividerY = headerY + headerH;
        setFeedTopY(dividerY);
        setFeedBottomY(dockY);
      });
    });
  }, []);

  useEffect(() => {
    if (!menuTarget) return;
    syncFeedBoundsY();
    const frame = requestAnimationFrame(syncFeedBoundsY);
    return () => cancelAnimationFrame(frame);
  }, [menuTarget, syncFeedBoundsY]);

  const clearReplyDraft = useCallback(() => {
    setReplyTo(null);
    setDeleteBarHeightPx(0);
  }, [setDeleteBarHeightPx]);

  const params = useLocalSearchParams<{
    conversationUuid: string;
    otherUserUuid?: string;
    otherDisplayName?: string;
    otherUsername?: string;
    otherAvatarUuid?: string;
    otherUserIsOnline?: string;
    otherUserLastSeenAt?: string;
  }>();

  const conversationUuid = routeParam(params.conversationUuid);
  const paramOtherUserUuid = routeParam(params.otherUserUuid);

  const scrollTrackingReadyRef = useRef(false);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
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

  useEffect(() => {
    resetDock();
    hideListUntilReady();
    setMenuTarget(null);
    setReplyTo(null);
    // Позиция ленты — величина потреда: перенесённая из прошлого треда, она
    // оставила бы новый тред «отмотанным вверх» (без возврата к якорю на
    // входящие) и могла бы показать в нём чужую плашку «Новые сообщения».
    atBottomRef.current = true;
    prevListLengthRef.current = 0;
    setShowJumpToLatest(false);
    resetBirthTracking();
    scrollTrackingReadyRef.current = false;
    seenMessageIdsRef.current = new Set();
    insertLiftSv.value = 0;
    peerAvatarHoldSv.value = 0;
    // resetDock is stable (ref-backed); only re-run on thread change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationUuid]);

  useFocusEffect(
    useCallback(() => {
      applyMessagesTabBarHidden(navigation, tabBarBottomInset, true);
      chatUiFrameKeepAlive.setActive(true);
      return () => {
        chatUiFrameKeepAlive.setActive(false);
        applyMessagesTabBarHidden(navigation, tabBarBottomInset, false);
        resetDock();
      };
    }, [chatUiFrameKeepAlive, navigation, tabBarBottomInset, resetDock]),
  );

  /**
   * Пока переход доигрывается, внутри экрана ничего не должно шевелиться — он и
   * так проявляется целиком. Длительность берём из тех же опций стека, которыми
   * настроен `Stack.Screen` треда, чтобы значения не разъехались.
   */
  useEffect(() => {
    const timer = setTimeout(
      finishEnterTransition,
      floraNativeStackOptions.animationDuration,
    );
    return () => clearTimeout(timer);
  }, [conversationUuid, finishEnterTransition]);

  const paramOtherDisplayName = routeParam(params.otherDisplayName);
  const paramOtherUsername = routeParam(params.otherUsername);
  const paramOtherAvatarUuid = routeParam(params.otherAvatarUuid);
  const paramOtherUserIsOnline = params.otherUserIsOnline;
  const paramOtherUserLastSeenAt = routeParam(params.otherUserLastSeenAt);
  const [sending, setSending] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);

  const me = useSessionStore((s) => s.me);
  const fscpStatus = useFscpStore((s) => s.status);
  const fscpReady = useFscpStore((s) => s.status === "ready");
  const fscpDecryptKey = useFscpStore((s) => s.localPubKey);
  const canSend = useFscpStore((s) => s.canSend);
  const decryptWirePlaintext = useFscpStore((s) => s.decryptWirePlaintext);
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

  const queryClient = useQueryClient();

  const peer = useMemo((): ChatPeerInfo => {
    const fromList = queryClient
      .getQueryData<{ items: MsgConversationDto[] }>(["conversations"])
      ?.items
      ?.find((c) => c.conversationUuid === conversationUuid);
    if (fromList) {
      return {
        otherUserUuid: fromList.otherUserUuid,
        otherUsername: fromList.otherUsername,
        otherDisplayName: fromList.otherDisplayName,
        otherAvatarUuid: fromList.otherAvatarUuid,
        otherUserIsOnline: fromList.otherUserIsOnline,
        otherUserLastSeenAt: fromList.otherUserLastSeenAt,
      };
    }
    return {
      otherUserUuid: paramOtherUserUuid,
      otherUsername: paramOtherUsername,
      otherDisplayName: paramOtherDisplayName || paramOtherUsername || "Пользователь",
      otherAvatarUuid: paramOtherAvatarUuid.trim() ? paramOtherAvatarUuid : null,
      otherUserIsOnline: parseBoolParam(paramOtherUserIsOnline),
      otherUserLastSeenAt: paramOtherUserLastSeenAt.trim() || null,
    };
  }, [
    conversationUuid,
    queryClient,
    paramOtherAvatarUuid,
    paramOtherDisplayName,
    paramOtherUserIsOnline,
    paramOtherUserLastSeenAt,
    paramOtherUserUuid,
    paramOtherUsername,
  ]);

  const otherUserUuid = peer.otherUserUuid || paramOtherUserUuid;
  const peerDisplayName = peer.otherDisplayName || peer.otherUsername || "Пользователь";

  useEffect(() => {
    if (!conversationUuid || otherUserUuid) return;
    void queryClient
      .fetchQuery({
        queryKey: ["conversations"],
        queryFn: () => apiGetConversations(),
        staleTime: 30_000,
      })
      .catch(() => undefined);
  }, [conversationUuid, otherUserUuid, queryClient]);

  const messagesQuery = useQuery({
    queryKey: ["messages", conversationUuid, otherUserUuid || ""],
    enabled: !!conversationUuid && !!otherUserUuid,
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
      void messagesQuery.refetch();
      void apiMarkConversationRead(conversationUuid)
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          requestTabBadgesRefresh();
        })
        .catch(() => undefined);
      void dismissMessagePushNotifications(conversationUuid);
    });
  }, [conversationUuid, messagesQuery, queryClient]);

  useEffect(() => {
    if (!conversationUuid) return;
    void apiMarkConversationRead(conversationUuid)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        requestTabBadgesRefresh();
        return dismissMessagePushNotifications(conversationUuid);
      })
      .catch(() => undefined);
  }, [conversationUuid, queryClient]);

  useEffect(() => {
    if (!conversationUuid || !otherUserUuid) return;
    const task = InteractionManager.runAfterInteractions(() => {
      void queryClient.fetchQuery({
        queryKey: ["messages", conversationUuid, otherUserUuid || ""],
        queryFn: async () => {
          const page = await apiGetMessages(conversationUuid, undefined, otherUserUuid || undefined);
          return applyMessagesPageToCaches({
            conversationUuid,
            otherUserUuid,
            page,
          });
        },
        staleTime: 60_000,
      });
    });
    return () => task.cancel();
  }, [conversationUuid, otherUserUuid, queryClient]);

  const messages = useMemo(
    () =>
      messagesQuery.data?.items ??
      messageThreadCache.get(conversationUuid) ??
      EMPTY_MESSAGES,
    [conversationUuid, messagesQuery.data?.items],
  );

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
    viewerUserUuid: me?.userUuid,
    fscpReady,
    fscpDecryptKey,
    decryptWirePlaintext,
  });

  /**
   * Лента перевёрнута: данные от новых к старым (индекс 0 у якоря).
   * Группы по raw `decrypted` (стабильный groupKey); чужие decrypting не в item —
   * иначе мелькает «Расшифровка…».
   */
  const listData = useMemo(() => {
    const chronological = buildThreadListItems(
      decrypted,
      (m) => m.isFromMe || m.decryptState !== "decrypting",
    );
    return chronological.reverse();
  }, [decrypted]);

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
   * Тред можно показывать, когда в visible нет decrypting: пока идут волны
   * `DECRYPT_BATCH`, высоты пузырей меняются. Peer decrypting скрыты из ленты.
   */
  const threadReady = useMemo(() => {
    if (listMessageCount === 0) return false;
    let hasDecrypting = false;
    forEachThreadListMessage(listData, (row) => {
      if (row.decryptState === "decrypting") hasDecrypting = true;
    });
    return !hasDecrypting;
  }, [listData, listMessageCount]);
  const listPending = messagesQuery.isLoading || (listMessageCount > 0 && !threadReady);

  /**
   * Показ ждёт ещё и замера дока. У перевёрнутой ленты зазор под последним
   * сообщением — это `contentInset`, то есть inset задаёт видимую позицию
   * напрямую. До замера он считается по оценке `COMPOSE_BASELINE_FALLBACK_PX`,
   * и пока она не сошлась с реальной высотой поля, лента стоит не на месте.
   * На холодном открытии это незаметно (расшифровка дольше замера), на тёплом
   * тред готов на первом кадре — и без этого условия показ попадает в окно
   * оценки.
   */
  useEffect(() => {
    if (threadReady && composeBaselinePx > 0) allowListReveal();
    // Тред мог смениться на такой же готовый — сброс делает эффект по треду выше.
  }, [allowListReveal, composeBaselinePx, conversationUuid, threadReady]);

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

  const renderScrollComponent = useCallback(
    (props: ScrollViewProps) => (
      <ChatScrollView
        {...props}
        offset={kgaOffsetRef.current}
        extraContentPadding={dockExtraPaddingSv}
        freeze={freezeListSv}
        animatedRef={listAnimatedRef}
        // Зазор под доком уезжает в contentInset.top, «конец» — офсет у нуля.
        inverted
      />
    ),
    [dockExtraPaddingSv, freezeListSv, listAnimatedRef],
  );

  // До paint (паритет Web useLayoutEffect): иначе после idle первый кадр без
  // counter-lift, а withTiming часто «оживает» только на жест.
  useLayoutEffect(() => {
    if (!threadReady || listMessageCount === 0) return;
    if (!scrollTrackingReadyRef.current) {
      const keys: string[] = [];
      const ids = new Set<string>();
      forEachThreadListMessage(listData, (row) => {
        keys.push(row.clientMessageKey ?? row.messageUuid);
        ids.add(row.messageUuid);
      });
      seedHydratedKeys(keys);
      seenMessageIdsRef.current = ids;
      scrollTrackingReadyRef.current = true;
      return;
    }

    const seen = seenMessageIdsRef.current;
    let incomingLiftPx = 0;
    const newlyPeerUuids = new Set<string>();
    forEachThreadListMessage(listData, (row) => {
      if (seen.has(row.messageUuid)) return;
      seen.add(row.messageUuid);
      rememberClientMessageKey(
        row.messageUuid,
        row.clientMessageKey ?? row.messageUuid,
      );
      // Исходящие уже крутят insertLift в onSend; здесь — только peer delta.
      if (!row.isFromMe) {
        newlyPeerUuids.add(row.messageUuid);
        markBirthPending(row.clientMessageKey ?? row.messageUuid);
        incomingLiftPx += estimateRowInsertLiftPx(row);
      }
    });
    if (incomingLiftPx > 0 && atBottomRef.current) {
      // Hold только при append в уже видимую группу; новая группа — аватар
      // едет вместе с сообщением (без контр-transform).
      const trailing = listData[0];
      const holdAvatar =
        trailing?.kind === "peerGroup" &&
        shouldHoldTrailingPeerAvatar(trailing.messages, newlyPeerUuids);
      // pin + lift в одном layout-кадре (как Web runInsertLift).
      pinListToBottom(false);
      setShowJumpToLatest(false);
      playChatListInsertLift(
        insertLiftSv,
        incomingLiftPx,
        holdAvatar ? peerAvatarHoldSv : undefined,
      );
    }
  }, [
    insertLiftSv,
    listData,
    listMessageCount,
    peerAvatarHoldSv,
    pinListToBottom,
    threadReady,
  ]);

  useEffect(() => {
    const prevLen = prevListLengthRef.current;
    const nextLen = listMessageCount;
    prevListLengthRef.current = nextLen;
    if (nextLen === 0 || nextLen === prevLen) return;
    // Прижатие в доке доскролливает только на смену зазора под доком, приход
    // строк его не трогает. У якоря есть допуск в CHAT_AT_BOTTOM_THRESHOLD_PX,
    // и входящее сообщение, пришедшее внутри этого допуска, осталось бы
    // частично под полем ввода — поэтому возврат к якорю здесь свой.
    // Non-animated pin: подъём ленты — insertLiftSv (общий с пузырём).
    // Считаем по числу сообщений, не items: append в peer-группу не меняет length items.
    // Peer-insert уже pin'ит в useLayoutEffect выше — здесь догон для own/прочих.
    if (atBottomRef.current) {
      pinListToBottom(false);
      setShowJumpToLatest(false);
      return;
    }
    setShowJumpToLatest(true);
  }, [listMessageCount, pinListToBottom]);


  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
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
    keyboardOpen,
    closeEmoji,
    dismissKeyboard,
    menuTarget,
    closeMessageMenu,
  ]);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = event.nativeEvent;
      // Лента перевёрнута: последнее сообщение стоит на якоре, а не в конце
      // контента. Порог отсчитывается от якоря — на iOS он отрицательный.
      const distanceFromAnchor =
        contentOffset.y - chatListAnchorOffset(dockExtraPaddingSv.value);
      const atBottom = distanceFromAnchor <= CHAT_AT_BOTTOM_THRESHOLD_PX;
      atBottomRef.current = atBottom;
      // Здесь прижатие только включаем. Снять его может лишь жест — иначе
      // промежуточный кадр собственной коррекции низа отменил бы коррекцию.
      if (atBottom) setListPinned(true);
      onEndVisible(atBottom);
      closeMessageMenu();
    },
    [closeMessageMenu, dockExtraPaddingSv, onEndVisible, setListPinned],
  );

  /** Программные скроллы дока drag-событий не порождают — снимает только палец. */
  const onScrollBeginDrag = useCallback(() => {
    setListPinned(false);
  }, [setListPinned]);

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
      const draft = replyDraftFromMessage(message, message.previewText, peerDisplayName);
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

  const onMessagePress = useCallback(
    (message: ThreadBubbleItem, anchor: BubbleAnchorRect) => {
      closeEmoji();
      dismissKeyboard();
      setMenuTarget((prev) =>
        prev?.message.messageUuid === message.messageUuid ? null : { message, anchor },
      );
    },
    [closeEmoji, dismissKeyboard],
  );

  const syncMenuAnchor = useCallback((messageUuid: string, anchor: BubbleAnchorRect) => {
    setMenuTarget((prev) => {
      if (prev?.message.messageUuid !== messageUuid) return prev;
      if (bubbleAnchorsEqual(prev.anchor, anchor)) return prev;
      return { ...prev, anchor };
    });
  }, []);

  const renderMessage = useCallback(
    ({ item }: { item: ThreadListItem }) => {
      // Обратный переворот строки: лента перевёрнута целиком (см. listInverted).
      if (item.kind === "peerGroup") {
        // Индекс 0 после reverse — trailing peer-группа у якоря; hold avatar на insertLift.
        const head = listData[0];
        const isTrailing =
          head?.kind === "peerGroup" && head.groupKey === item.groupKey;
        return (
          <View style={styles.rowInverted}>
            <ChatPeerMessageGroup
              messages={item.messages}
              peer={peer}
              menuTargetUuid={menuTarget?.message.messageUuid ?? null}
              onPress={onMessagePress}
              onAnchorSync={syncMenuAnchor}
              holdAvatarStyle={isTrailing ? peerAvatarHoldStyle : undefined}
            />
          </View>
        );
      }

      const message = item.message;
      const isMenuTarget = menuTarget?.message.messageUuid === message.messageUuid;
      const clientKey = message.clientMessageKey ?? message.messageUuid;
      return (
        <View style={styles.rowInverted}>
          <ChatMessageBirthHost clientMessageKey={clientKey}>
            <ChatMessageBubble
              message={message}
              peer={peer}
              showPeerAvatar={false}
              isPeerIndented={false}
              isMenuTarget={isMenuTarget}
              onPress={(anchor) => onMessagePress(message, anchor)}
              onAnchorSync={
                isMenuTarget ? (anchor) => syncMenuAnchor(message.messageUuid, anchor) : undefined
              }
            />
          </ChatMessageBirthHost>
        </View>
      );
    },
    [
      listData,
      menuTarget?.message.messageUuid,
      onMessagePress,
      peer,
      peerAvatarHoldStyle,
      syncMenuAnchor,
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
    if (!canSend() || !otherUserUuid) return;
    closeEmoji();
    enterVoiceMode();
    await voiceRecorder.start();
  }, [canSend, closeEmoji, enterVoiceMode, otherUserUuid, voiceRecorder]);

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
    if (!conversationUuid || !me?.userUuid || !otherUserUuid || !voiceDraft) return;
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

    setSending(true);
    await voiceRecorder.discard();
    clearVoiceDraft();
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
    playChatListInsertLift(insertLiftSv, estimateBlocksInsertLiftPx(optimisticBlocks));

    try {
      const peerKey = await apiGetUserE2ePublicKey(otherUserUuid);
      if (!peerKey.publicKeyBase64) throw new Error("У собеседника нет E2E-ключа");

      const voiceBlock = await uploadPreparedMessageVoice({
        toUserUuid: otherUserUuid,
        sourceUri,
        contentType,
        durationMs,
        waveform,
      });

      registerPendingVoiceUri(voiceBlock.assetUuid, sourceUri);
      clearPendingVoiceUri(provisionalAssetUuid);

      const wire = await buildBlocksMessageWire({
        senderUserUuid: me.userUuid,
        receiverUserUuid: otherUserUuid,
        material,
        receiverAgreementPublicKeyBase64: peerKey.publicKeyBase64,
        blocks: [voiceBlock],
        replyTo: activeReply ?? undefined,
      });
      const encryptedPushPreviews = await buildEncryptedPushPreviews({
        wire,
        recipientUserUuid: otherUserUuid,
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
        otherUserUuid,
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
        otherUserUuid,
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
    me?.userUuid,
    otherUserUuid,
    pinListToBottom,
    queryClient,
    replyTo,
    setDeleteBarHeightPx,
    insertLiftSv,
    voiceDraft,
    voiceRecorder,
  ]);

  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!conversationUuid || !otherUserUuid) return undefined;
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      void apiPostTyping(conversationUuid, false, otherUserUuid).catch(() => {});
    };
  }, [conversationUuid, otherUserUuid]);

  const onComposeTextChange = useCallback(
    (text: string) => {
      if (!conversationUuid || !otherUserUuid) return;
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
      if (!text.trim()) {
        void apiPostTyping(conversationUuid, false, otherUserUuid).catch(() => {});
        return;
      }
      typingTimerRef.current = setTimeout(() => {
        typingTimerRef.current = null;
        void apiPostTyping(conversationUuid, true, otherUserUuid).catch(() => {});
        void apiPresenceHeartbeat().catch(() => {});
      }, PRESENCE_TYPING_DEBOUNCE_MS);
    },
    [conversationUuid, otherUserUuid],
  );

  const onSend = async (draft: string) => {
    const trimmed = draft.trim();
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

    void apiPostTyping(conversationUuid, false, otherUserUuid).catch(() => {});
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
    playChatListInsertLift(insertLiftSv, estimateBlocksInsertLiftPx(optimisticBlocks));

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
      <View ref={chatHeaderWrapRef} collapsable={false}>
        <ChatThreadHeader
          peer={peer}
          moreButtonRef={moreBtnRef}
          onMorePress={() => setMoreMenuOpen(true)}
        />
      </View>

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

      <KeyboardGestureArea
        style={styles.chatBody}
        interpolator="ios"
        textInputNativeID="chat-compose-input"
        offset={kgaOffsetPx}
      >
      <View style={styles.messagesArea}>
        {/*
          Заглушка — отдельный слой под лентой, а не `ListEmptyComponent`: иначе
          она гаснет вместе с лентой и между ней и контентом зияет пустой
          промежуток на всю раскладку FlashList. Здесь два слоя одного перехода.
        */}
        <Reanimated.View
          pointerEvents="none"
          style={[styles.listFill, styles.listPlaceholder, listPlaceholderStyle]}
        >
          {listPending ? (
            <>
              <ActivityIndicator color={floraColors.greenLight} />
              <Text style={styles.emptyText}>Загрузка сообщений…</Text>
            </>
          ) : (
            <Text style={styles.emptyText}>
              {blocked ? "Расшифровка недоступна" : "Напишите первое сообщение"}
            </Text>
          )}
        </Reanimated.View>

        <Reanimated.View style={[styles.listFill, listRevealStyle, listLiftStyle]}>
          {/* insertLift: тот же transform для ленты и нового пузыря (без отдельного bubble translate). */}
          <Reanimated.View style={[styles.listFill, listInsertLiftStyle]}>
            <FlashList
              key={conversationUuid}
              data={listData}
              keyExtractor={listItemKey}
              getItemType={messageItemType}
              style={styles.listInverted}
              contentContainerStyle={styles.listContent}
              renderScrollComponent={renderScrollComponent}
              onScroll={onScroll}
              onScrollBeginDrag={onScrollBeginDrag}
              scrollEventThrottle={16}
              keyboardShouldPersistTaps="handled"
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
              renderItem={renderMessage}
            />
          </Reanimated.View>
        </Reanimated.View>

        {showJumpToLatest ? (
          <Reanimated.View style={[styles.jumpBtn, jumpBtnBottomStyle]}>
            <Pressable onPress={() => scrollToEnd(true)}>
              <Text style={styles.jumpBtnText}>Новые сообщения</Text>
            </Pressable>
          </Reanimated.View>
        ) : null}

        <MessageBubbleMoreMenu
          open={menuTarget != null}
          anchor={menuTarget?.anchor ?? null}
          feedTopY={feedTopY}
          feedBottomY={feedBottomY}
          isFromMe={menuTarget?.message.isFromMe ?? false}
          canReplyCopy={
            menuTarget != null &&
            menuTarget.message.decryptState === "ok" &&
            menuTarget.message.previewText.length > 0
          }
          canReply={
            menuTarget != null &&
            menuTarget.message.decryptState === "ok" &&
            menuTarget.message.previewText.length > 0 &&
            menuTarget.message.sendStatus !== "sending"
          }
          canDelete={
            menuTarget != null &&
            menuTarget.message.isFromMe &&
            menuTarget.message.sendStatus !== "sending"
          }
          onClose={closeMessageMenu}
          onReply={
            menuTarget
              ? () => beginReplyToMessage(menuTarget.message)
              : undefined
          }
          onCopy={
            menuTarget
              ? () => void copyMessageContent(menuTarget.message.previewText)
              : undefined
          }
          onDelete={
            menuTarget?.message.isFromMe
              ? () => handleDeleteMessage(menuTarget.message.messageUuid)
              : undefined
          }
        />
      </View>

      <Reanimated.View ref={dockFooterRef} collapsable={false} style={[styles.dockFooter, dockStickyStyle]}>
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
            disabled={!canSend() || !otherUserUuid}
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

      <ChatMoreMenu
        open={moreMenuOpen}
        onClose={() => setMoreMenuOpen(false)}
        anchorRef={moreBtnRef}
        onMute={() => {
          if (conversationUuid) void apiMuteConversation(conversationUuid);
        }}
        onArchive={() => {
          if (conversationUuid) void apiArchiveConversation(conversationUuid);
        }}
      />

      <FscpUnlockSheet
        visible={unlockOpen}
        userUuid={me?.userUuid ?? null}
        onClose={() => setUnlockOpen(false)}
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
  },
  /**
   * Переворот ленты целиком: последнее сообщение оказывается в начале скролла,
   * то есть «внизу» — это константный офсет, а не считаемый из высот предел.
   */
  listInverted: {
    ...StyleSheet.absoluteFill,
    transform: [{ scaleY: -1 }],
  },
  rowInverted: {
    transform: [{ scaleY: -1 }],
  },
  /**
   * В координатах скролла это низ, а на экране — верх ленты (над самым старым
   * сообщением): столько же, сколько marginBottom пузыря до линии compose.
   */
  listContent: {
    paddingBottom: floraMessages.bubbleRowGap,
  },
  /**
   * Док — absolute-оверлей у низа: рост слота не влияет на layout ленты
   * (лента компенсируется через extraContentPadding), двигается transform-ом.
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
