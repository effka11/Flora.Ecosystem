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
  messagePlaintextFromBlocks,
  plaintextToPreview,
  sendTextMessage,
  type FscpMessageBlock,
} from "@flora/client-core/fscp";
import type { MsgConversationDto, MsgMessageDto } from "@flora/client-core/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ChatComposeField,
  type ChatComposeFieldHandle,
} from "@/components/messages/ChatComposeField";
import { ChatMessageBubble, type ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import { ChatMessageEmojiPanel } from "@/components/messages/ChatMessageEmojiPanel";
import { ChatMoreMenu } from "@/components/messages/ChatMoreMenu";
import { ChatThreadHeader, type ChatPeerInfo } from "@/components/messages/ChatThreadHeader";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import { applyMessagesTabBarHidden } from "@/lib/messagesTabBar";
import { setActiveMessageThread } from "@/lib/activeMessageThread";
import { dismissMessagePushNotifications } from "@/lib/pushNotifications";
import { subscribeMessageRealtime } from "@/lib/realtimeSync";
import { requestTabBadgesRefresh } from "@/lib/useTabBadges";
import { useChatComposeDock } from "@/lib/useChatComposeDock";
import { uploadPreparedMessageImage } from "@/lib/messageImageAssets";
import { appendOutgoingThreadMessage } from "@/lib/messageThreadOutgoing";
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
  const composeBottomInset = Math.max(insets.bottom, floraSpacing.gridFine);
  // Лишний нижний padding прячем за клавиатуру → зазор над IME = composeShellPaddingKeyboard.
  const composeLiftAdjust =
    floraMessages.composeShellPaddingKeyboard -
    (composeBottomInset + floraMessages.composeShellPaddingBottomExtra);
  const {
    lift: keyboardLift,
    panelSlide,
    emojiPanelMounted,
    emojiContentReady,
    bottomInset: dockInset,
    panelHeight,
    emojiOpen,
    openEmoji,
    closeEmoji,
    showKeyboard,
  } = useChatComposeDock(composeLiftAdjust);
  const listRef = useRef<FlatList<ListRow>>(null);
  const composeRef = useRef<ChatComposeFieldHandle>(null);
  const moreBtnRef = useRef<View>(null);
  const atBottomRef = useRef(true);
  const prevListLengthRef = useRef(0);
  const [actionMessageUuid, setActionMessageUuid] = useState<string | null>(null);

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

  useFocusEffect(
    useCallback(() => {
      applyMessagesTabBarHidden(navigation, tabBarBottomInset, true);
      return () => {
        applyMessagesTabBarHidden(navigation, tabBarBottomInset, false);
      };
    }, [navigation, tabBarBottomInset]),
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
    listRef.current?.scrollToEnd({ animated });
    atBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [listData.length]);

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
    if (dockInset <= 0 || !atBottomRef.current) return;
    requestAnimationFrame(() => scrollToEnd(true));
  }, [dockInset, scrollToEnd]);

  useEffect(() => {
    if (Platform.OS !== "android" || !emojiPanelMounted) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeEmoji();
      return true;
    });
    return () => sub.remove();
  }, [emojiPanelMounted, closeEmoji]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const atBottom = distanceFromBottom < floraSpacing.grid * 2;
    atBottomRef.current = atBottom;
    if (atBottom) setShowJumpToLatest(false);
    setActionMessageUuid(null);
  }, []);

  const onMessageLongPress = useCallback((messageUuid: string) => {
    setActionMessageUuid(messageUuid);
  }, []);

  const confirmDeleteMessage = useCallback(
    (messageUuid: string) => {
      if (!conversationUuid) return;
      Alert.alert("Удалить сообщение?", "Сообщение исчезнет у обоих участников.", [
        { text: "Отмена", style: "cancel", onPress: () => setActionMessageUuid(null) },
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
                setActionMessageUuid(null);
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
    [conversationUuid, otherUserUuid, queryClient],
  );

  const renderMessage = useCallback(
    ({ item }: { item: ListRow }) => (
      <ChatMessageBubble
        message={item}
        peer={peer}
        showPeerAvatar={item.showPeerAvatar}
        isPeerIndented={item.isPeerIndented}
        showDeleteAction={item.isFromMe && actionMessageUuid === item.messageUuid}
        onLongPressOwn={
          item.isFromMe ? () => onMessageLongPress(item.messageUuid) : undefined
        }
      />
    ),
    [peer, actionMessageUuid, onMessageLongPress],
  );

  const onPickImages = useCallback(async () => {
    if (!canSend()) return;
    const error = await pickImages();
    if (error) Alert.alert("Фото", error);
  }, [canSend, pickImages]);

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
      });
      const sent = await sendTextMessage({
        conversationUuid,
        wire,
        attachments: { voiceAssetUuids: [voiceBlock.assetUuid] },
        pushPreview: plaintextToPreview(messagePlaintextFromBlocks([voiceBlock])),
      });
      appendOutgoingThreadMessage({
        queryClient,
        conversationUuid,
        otherUserUuid,
        senderUserUuid: me.userUuid,
        sent,
        wire,
        blocks: [voiceBlock],
      });
      await voiceRecorder.discard();
      clearVoiceDraft();
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
      });
      const previewPlain = messagePlaintextFromBlocks(blocks);
      const sent = await sendTextMessage({
        conversationUuid,
        wire,
        attachments: imageAssetUuids.length > 0 ? { imageAssetUuids } : undefined,
        pushPreview: plaintextToPreview(previewPlain),
      });
      appendOutgoingThreadMessage({
        queryClient,
        conversationUuid,
        otherUserUuid,
        senderUserUuid: me.userUuid,
        sent,
        wire,
        blocks,
      });
      setText("");
      clearImages();
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

  // Compose поднимается на dockInset + composeLiftAdjust (нижний safe-area padding уходит за IME).
  // paddingBottom ленты должен совпадать с визуальным подъёмом, иначе зазор до divider растёт.
  // Зазор до линии compose — marginBottom последнего пузыря (bubbleRowGap).
  const listPaddingBottom = Math.max(0, dockInset + composeLiftAdjust);
  const jumpBtnBottom = listPaddingBottom + floraSpacing.grid;

  return (
    <View style={styles.root}>
      <ChatThreadHeader
        peer={peer}
        moreButtonRef={moreBtnRef}
        onMorePress={() => setMoreMenuOpen(true)}
      />

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

      <View style={styles.messagesArea}>
        <FlatList
          ref={listRef}
          data={listData}
          keyExtractor={(item) => item.messageUuid}
          contentContainerStyle={[styles.listContent, { paddingBottom: listPaddingBottom }]}
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
          <Pressable
            style={[styles.jumpBtn, { bottom: jumpBtnBottom }]}
            onPress={() => scrollToEnd(true)}
          >
            <Text style={styles.jumpBtnText}>Новые сообщения</Text>
          </Pressable>
        ) : null}
      </View>

      {actionMessageUuid ? (
        <View style={styles.messageDeleteBar}>
          <Pressable
            style={styles.messageDeleteBtn}
            onPress={() => confirmDeleteMessage(actionMessageUuid)}
            accessibilityRole="button"
            accessibilityLabel="Удалить сообщение"
          >
            <Text style={styles.messageDeleteBtnText}>Удалить</Text>
          </Pressable>
          <Pressable
            style={styles.messageDeleteCancelBtn}
            onPress={() => setActionMessageUuid(null)}
            accessibilityRole="button"
            accessibilityLabel="Отмена"
          >
            <Text style={styles.messageDeleteCancelText}>Отмена</Text>
          </Pressable>
        </View>
      ) : null}

      <Animated.View style={[styles.composeDock, { transform: [{ translateY: keyboardLift }] }]}>
        <ChatComposeField
          ref={composeRef}
          value={text}
          onChangeText={setText}
          onSend={onSend}
          sending={sending}
          disabled={!canSend() || !otherUserUuid}
          placeholder={blocked ? "Отправка недоступна" : "Сообщение"}
          bottomInset={composeBottomInset}
          emojiOpen={emojiOpen}
          onRequestEmoji={openEmoji}
          onRequestKeyboard={() => showKeyboard(() => composeRef.current?.focusInput())}
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
      </Animated.View>

      {/* Панель эмодзи — absolute, выезжает снизу (panelSlide). Поле ввода сразу в целевой позиции. */}
      {emojiPanelMounted ? (
        <Animated.View
          style={[
            styles.emojiPanelOuter,
            {
              height: panelHeight + floraMessages.emojiPanelOuterGap,
              paddingBottom: insets.bottom + floraMessages.emojiPanelBottomExtra,
              transform: [{ translateY: panelSlide }],
            },
          ]}
        >
          <View style={styles.emojiPanelCard}>
            {emojiContentReady ? (
              <ChatMessageEmojiPanel onPickEmoji={(emoji) => composeRef.current?.insertToken(emoji)} />
            ) : null}
          </View>
        </Animated.View>
      ) : null}

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
  messagesArea: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  emojiPanelOuter: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: floraMessages.emojiPanelOuterGap,
    paddingHorizontal: floraMessages.emojiPanelOuterGap,
  },
  emojiPanelCard: {
    flex: 1,
    borderRadius: floraMessages.emojiPanelRadius,
    borderWidth: 1,
    borderColor: floraMessages.composeBorderColor,
    overflow: "hidden",
    backgroundColor: floraColors.surfaceElevated,
  },
  composeDock: {
    backgroundColor: floraColors.bg,
  },
  messageDeleteBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: floraSpacing.grid,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: floraMessages.composeBorderColor,
    backgroundColor: floraColors.bg,
    zIndex: 20,
    elevation: 8,
  },
  messageDeleteBtn: {
    paddingVertical: floraSpacing.gridFine + 2,
    paddingHorizontal: floraSpacing.grid * 2,
    borderRadius: floraMessages.composeRadius,
    backgroundColor: "rgba(220, 53, 69, 0.14)",
  },
  messageDeleteBtnText: {
    color: "#dc3545",
    fontSize: 15,
    fontWeight: "600",
  },
  messageDeleteCancelBtn: {
    paddingVertical: floraSpacing.gridFine + 2,
    paddingHorizontal: floraSpacing.grid,
  },
  messageDeleteCancelText: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "500",
  },
  listContent: {
    paddingTop: floraMessages.bubbleGap,
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
