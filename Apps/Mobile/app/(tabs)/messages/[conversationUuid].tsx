import {
  apiGetConversations,
  apiGetMessages,
  apiMarkConversationRead,
  apiArchiveConversation,
  apiMuteConversation,
  apiDeleteMessage,
} from "@flora/client-core/api";
import {
  apiGetUserE2ePublicKey,
  buildBlocksMessageWire,
  sendTextMessage,
  type FscpMessageBlock,
} from "@flora/client-core/fscp";
import type { MsgConversationDto, MsgMessageDto } from "@flora/client-core/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
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
import Reanimated from "react-native-reanimated";
import {
  ChatComposeField,
  type ChatComposeFieldHandle,
} from "@/components/messages/ChatComposeField";
import { ChatComposeReplyBar } from "@/components/messages/ChatComposeReplyBar";
import { ChatMessageBubble, type ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import { ChatMessageEmojiPanel } from "@/components/messages/ChatMessageEmojiPanel";
import { ChatMoreMenu } from "@/components/messages/ChatMoreMenu";
import {
  MessageBubbleMoreMenu,
  bubbleAnchorsEqual,
  type BubbleAnchorRect,
} from "@/components/messages/MessageBubbleMoreMenu";
import { ChatThreadHeader, type ChatPeerInfo } from "@/components/messages/ChatThreadHeader";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import { applyMessagesTabBarHidden } from "@/lib/messagesTabBar";
import { setActiveMessageThread } from "@/lib/activeMessageThread";
import { dismissMessagePushNotifications } from "@/lib/pushNotifications";
import { subscribeMessageRealtime } from "@/lib/realtimeSync";
import { requestTabBadgesRefresh } from "@/lib/useTabBadges";
import { useChatComposeDock } from "@/lib/useChatComposeDock";
import {
  ChatScrollView,
  type ChatScrollViewRef,
} from "@/lib/ChatScrollView";
import {
  CHAT_AT_BOTTOM_THRESHOLD_PX,
  COMPOSE_BASELINE_FALLBACK_PX,
  emojiPanelChromePadding,
  keyboardStickyOffsets,
  resolveMessagesDockBottomInset,
} from "@/lib/messagesDockInsets";
import { uploadPreparedMessageImage } from "@/lib/messageImageAssets";
import { copyTextToClipboard } from "@/lib/copyToClipboard";
import { appendOutgoingThreadMessage } from "@/lib/messageThreadOutgoing";
import { replyDraftFromMessage, type MessageReplyDraft } from "@/lib/messageReply";
import { uploadPreparedMessageVoice } from "@/lib/messageVoiceAssets";
import { registerPendingVoiceUri } from "@/lib/pendingVoiceOutgoing";
import { useMessageComposeImages } from "@/lib/useMessageComposeImages";
import { useMessageComposeVoice } from "@/lib/useMessageComposeVoice";
import { useVoiceRecorder } from "@/lib/useVoiceRecorder";
import { useThreadMessageDecrypt } from "@/lib/useThreadMessageDecrypt";
import { messageThreadCache } from "@/stores/messageThreadCache";
import { useFscpStore } from "@/stores/fscpStore";
import { FscpUnlockSheet } from "@/components/fscp/FscpUnlockSheet";
import { useSessionStore } from "@/stores/sessionStore";

type ListRow = ThreadBubbleItem & {
  showPeerAvatar: boolean;
  isPeerIndented: boolean;
};

const EMPTY_MESSAGES: MsgMessageDto[] = [];

function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function parseBoolParam(value: string | string[] | undefined): boolean {
  const raw = routeParam(value);
  return raw === "1" || raw === "true";
}

function buildListRows(items: ThreadBubbleItem[]): ListRow[] {
  return items.map((message, index) => {
    if (message.isFromMe) {
      return { ...message, showPeerAvatar: false, isPeerIndented: false };
    }
    const next = items[index + 1];
    const showPeerAvatar = !next || next.isFromMe;
    const isPeerIndented = !showPeerAvatar;
    return { ...message, showPeerAvatar, isPeerIndented };
  });
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
    onListLayout,
    onListContentSizeChange,
    composeBaselinePx,
    emojiPanelHeightPx,
    emojiPanelReady,
    onComposeShellLayout,
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

  const chatScrollViewRef = useRef<ChatScrollViewRef>(null);
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

  useEffect(() => {
    resetDock();
    setMenuTarget(null);
    setReplyTo(null);
    // resetDock is stable (ref-backed); only re-run on thread change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationUuid]);

  useFocusEffect(
    useCallback(() => {
      applyMessagesTabBarHidden(navigation, tabBarBottomInset, true);
      return () => {
        applyMessagesTabBarHidden(navigation, tabBarBottomInset, false);
        resetDock();
      };
    }, [navigation, tabBarBottomInset, resetDock]),
  );

  const paramOtherDisplayName = routeParam(params.otherDisplayName);
  const paramOtherUsername = routeParam(params.otherUsername);
  const paramOtherAvatarUuid = routeParam(params.otherAvatarUuid);
  const paramOtherUserIsOnline = params.otherUserIsOnline;
  const paramOtherUserLastSeenAt = routeParam(params.otherUserLastSeenAt);
  const [text, setText] = useState("");
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
      return cached ? { items: cached, nextCursor: null } : undefined;
    },
    queryFn: async () => {
      const page = await apiGetMessages(conversationUuid, undefined, otherUserUuid || undefined);
      messageThreadCache.set(conversationUuid, page.items);
      return page;
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
      void queryClient.invalidateQueries({ queryKey: ["messages", conversationUuid] });
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
    if (!conversationUuid) return;
    const task = InteractionManager.runAfterInteractions(() => {
      void queryClient.fetchQuery({
        queryKey: ["messages", conversationUuid, otherUserUuid || ""],
        queryFn: async () => {
          const page = await apiGetMessages(conversationUuid, undefined, otherUserUuid || undefined);
          messageThreadCache.set(conversationUuid, page.items);
          return page;
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

  const listData = useMemo(() => buildListRows(decrypted), [decrypted]);
  const hasDecryptFailures = useMemo(
    () => fscpReady && decrypted.some((row) => row.decryptState === "failed"),
    [decrypted, fscpReady],
  );

  const scrollToEnd = useCallback((animated = true) => {
    if (listData.length === 0) return;
    chatScrollViewRef.current?.scrollToEnd({ animated });
    atBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [listData.length]);

  const onEndVisible = useCallback((visible: boolean) => {
    atBottomRef.current = visible;
    if (visible) setShowJumpToLatest(false);
  }, []);

  const renderScrollComponent = useCallback(
    (props: ScrollViewProps) => (
      <ChatScrollView
        {...props}
        offset={kgaOffsetPx}
        extraContentPadding={dockExtraPaddingSv}
        freeze={freezeListSv}
        chatScrollViewRef={chatScrollViewRef}
        animatedRef={listAnimatedRef}
        onListLayoutHeight={onListLayout}
        onListContentHeight={onListContentSizeChange}
      />
    ),
    [
      dockExtraPaddingSv,
      freezeListSv,
      kgaOffsetPx,
      listAnimatedRef,
      onListContentSizeChange,
      onListLayout,
    ],
  );

  const onComposeTextChange = useCallback((next: string) => {
    setText(next);
  }, []);

  useEffect(() => {
    const prevLen = prevListLengthRef.current;
    const nextLen = listData.length;
    prevListLengthRef.current = nextLen;
    if (nextLen === 0 || nextLen === prevLen) return;

    if (atBottomRef.current) {
      requestAnimationFrame(() => scrollToEnd(false));
      return;
    }
    setShowJumpToLatest(true);
  }, [listData.length, scrollToEnd]);

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
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
      const atBottom = distanceFromBottom < CHAT_AT_BOTTOM_THRESHOLD_PX;
      atBottomRef.current = atBottom;
      onEndVisible(atBottom);
      closeMessageMenu();
    },
    [closeMessageMenu, onEndVisible],
  );

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
    ({ item }: { item: ListRow }) => {
      const isMenuTarget = menuTarget?.message.messageUuid === item.messageUuid;
      return (
        <ChatMessageBubble
          message={item}
          peer={peer}
          showPeerAvatar={item.showPeerAvatar}
          isPeerIndented={item.isPeerIndented}
          isMenuTarget={isMenuTarget}
          onPress={(anchor) => onMessagePress(item, anchor)}
          onAnchorSync={
            isMenuTarget ? (anchor) => syncMenuAnchor(item.messageUuid, anchor) : undefined
          }
        />
      );
    },
    [menuTarget?.message.messageUuid, onMessagePress, peer, syncMenuAnchor],
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
    const activeReply = replyTo;

    setSending(true);
    try {
      const peerKey = await apiGetUserE2ePublicKey(otherUserUuid);
      if (!peerKey.publicKeyBase64) throw new Error("У собеседника нет E2E-ключа");

      const voiceBlock = await uploadPreparedMessageVoice({
        toUserUuid: otherUserUuid,
        sourceUri,
        contentType,
        durationMs: voiceDraft.durationMs,
        waveform: voiceDraft.waveform,
      });

      registerPendingVoiceUri(voiceBlock.assetUuid, sourceUri);

      const wire = await buildBlocksMessageWire({
        senderUserUuid: me.userUuid,
        receiverUserUuid: otherUserUuid,
        material,
        receiverAgreementPublicKeyBase64: peerKey.publicKeyBase64,
        blocks: [voiceBlock],
        replyTo: activeReply ?? undefined,
      });
      const sent = await sendTextMessage({
        conversationUuid,
        wire,
        attachments: { voiceAssetUuids: [voiceBlock.assetUuid] },
      });
      appendOutgoingThreadMessage({
        queryClient,
        conversationUuid,
        otherUserUuid,
        senderUserUuid: me.userUuid,
        sent,
        wire,
        blocks: [voiceBlock],
        replyTo: activeReply ?? undefined,
      });
      await voiceRecorder.discard();
      clearVoiceDraft();
      setReplyTo(null);
      setDeleteBarHeightPx(0);
      atBottomRef.current = true;
      void queryClient.invalidateQueries({ queryKey: ["messages", conversationUuid] });
    } catch (err) {
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
    queryClient,
    replyTo,
    setDeleteBarHeightPx,
    voiceDraft,
    voiceRecorder,
  ]);

  const onSend = async () => {
    const trimmed = text.trim();
    if (!conversationUuid || !me?.userUuid || !otherUserUuid) return;
    if (!trimmed && composeImages.length === 0) return;
    if (!canSend() || hasPendingPrepare) return;
    const material = useFscpStore.getState().material;
    if (!material) return;
    const activeReply = replyTo;
    setSending(true);
    try {
      const peerKey = await apiGetUserE2ePublicKey(otherUserUuid);
      if (!peerKey.publicKeyBase64) throw new Error("У собеседника нет E2E-ключа");

      const blocks: FscpMessageBlock[] = [];
      const imageAssetUuids: string[] = [];
      if (trimmed) blocks.push({ kind: "text", body: trimmed });
      for (const image of composeImages) {
        const uploaded = await uploadPreparedMessageImage({
          toUserUuid: otherUserUuid,
          prepared: {
            uri: image.uri,
            contentType: image.contentType,
            fileName: "photo.jpg",
          },
        });
        blocks.push(uploaded);
        imageAssetUuids.push(uploaded.assetUuid);
      }
      if (blocks.length === 0) return;

      const wire = await buildBlocksMessageWire({
        senderUserUuid: me.userUuid,
        receiverUserUuid: otherUserUuid,
        material,
        receiverAgreementPublicKeyBase64: peerKey.publicKeyBase64,
        blocks,
        replyTo: activeReply ?? undefined,
      });
      const sent = await sendTextMessage({
        conversationUuid,
        wire,
        attachments: imageAssetUuids.length > 0 ? { imageAssetUuids } : undefined,
      });
      appendOutgoingThreadMessage({
        queryClient,
        conversationUuid,
        otherUserUuid,
        senderUserUuid: me.userUuid,
        sent,
        wire,
        blocks,
        replyTo: activeReply ?? undefined,
      });
      setText("");
      clearImages();
      setReplyTo(null);
      setDeleteBarHeightPx(0);
      atBottomRef.current = true;
      void queryClient.invalidateQueries({ queryKey: ["messages", conversationUuid] });
    } catch (err) {
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
        <FlatList
          key={conversationUuid}
          data={listData}
          keyExtractor={(item) => item.messageUuid}
          style={styles.listFill}
          contentContainerStyle={styles.listContent}
          renderScrollComponent={renderScrollComponent}
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={6}
          maxToRenderPerBatch={4}
          windowSize={7}
          removeClippedSubviews={false}
          renderItem={renderMessage}
          ListEmptyComponent={
            messagesQuery.isLoading ? (
              <View style={styles.empty}>
                <ActivityIndicator color={floraColors.greenLight} />
                <Text style={styles.emptyText}>Загрузка сообщений…</Text>
              </View>
            ) : (
              <Text style={styles.emptyText}>
                {blocked ? "Расшифровка недоступна" : "Напишите первое сообщение"}
              </Text>
            )
          }
        />

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
            value={text}
            onChangeText={onComposeTextChange}
            onSend={onSend}
            sending={sending}
            disabled={!canSend() || !otherUserUuid}
            placeholder={blocked ? "Отправка недоступна" : "Сообщение"}
            bottomInset={composeBottomInset}
            onShellLayout={onComposeShellLayout}
            emojiAccessoryActive={emojiAccessoryActive}
            onToggleEmoji={() =>
              toggleEmoji(() => composeRef.current?.showInputKeyboard())
            }
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
  },
  listFill: {
    ...StyleSheet.absoluteFill,
  },
  /** Сверху — как marginBottom пузыря до линии compose (bubbleRowGap). */
  listContent: {
    paddingTop: floraMessages.bubbleRowGap,
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
  empty: {
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingTop: floraSpacing.grid * 4,
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
