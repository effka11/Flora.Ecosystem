/**
 * FSCP-G thread data + send/leave/members for Mobile.
 * Crypto/HTTP only via @flora/client-core; plaintext stays out of RQ wire.
 */

import {
  apiAddGroupMember,
  apiGetGroup,
  ApiRequestError,
  apiLeaveGroup,
  apiMarkGroupRead,
  apiPatchGroupTitle,
  apiRemoveGroupMember,
  apiSendGroupMessage,
} from "@flora/client-core/api";
import type { MsgConversationDto, MsgMessageDto } from "@flora/client-core/contracts";
import {
  buildGroupBlocksMessageWire,
  buildGroupTextMessageWire,
  extractTextFromPlaintext,
  filterMembersWithE2eKeys,
  getImageBlocksFromPlaintext,
  getPrimaryVoiceBlock,
  messagePlaintextFromBlocks,
  plaintextToPreview,
  type FscpMessageBlock,
  type FscpMessageReplyRef,
} from "@flora/client-core/fscp";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "react-native";
import { groupRosterNeedsRefresh, mergeGroupDetail } from "@/lib/groupChatMap";
import type { GroupChat } from "@/lib/groupChatTypes";
import {
  getGroupPendingOutgoing,
  mergeGroupPendingIntoMessages,
  setGroupPendingOutgoing,
} from "@/lib/groupThreadCrypto";
import {
  markBirthPending,
  optimisticPayloadSentinel,
  rememberClientMessageKey,
  takeClientMessageKey,
} from "@/lib/messageBirthRegistry";
import { floraNewUuid } from "@/lib/floraUuid";
import {
  fetchThreadFirstPage,
  THREAD_FIRST_PAGE_STALE_MS,
} from "@/lib/threadFirstPage";
import { messageDecryptCacheKey } from "@/lib/useThreadMessageDecrypt";
import { requestTabBadgesRefresh } from "@/lib/useTabBadges";
import { useFscpStore } from "@/stores/fscpStore";
import {
  messageThreadDecryptCache,
} from "@/stores/messageThreadCache";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";

export const groupMessagesQueryKey = (conversationUuid: string) =>
  ["group-messages", conversationUuid] as const;

/** Стабильная ссылка «участников нет»: `?? []` ломал мемоизацию потребителей. */
const EMPTY_MEMBERS: GroupChat["members"] = [];

type GroupMessagesPage = { items: MsgMessageDto[]; nextCursor: string | null };

function seedPendingDecryptRow(
  dto: MsgMessageDto,
  blocks: FscpMessageBlock[],
  clientMessageKey: string,
  replyTo?: FscpMessageReplyRef,
): void {
  const plain = messagePlaintextFromBlocks(blocks, dto.createdAt);
  if (replyTo) plain.replyTo = replyTo;
  const row: ThreadBubbleItem = {
    messageUuid: dto.messageUuid,
    clientMessageKey,
    text: extractTextFromPlaintext(plain),
    previewText: plaintextToPreview(plain),
    imageBlocks: getImageBlocksFromPlaintext(plain),
    voiceBlock: getPrimaryVoiceBlock(plain),
    replyTo,
    isFromMe: true,
    createdAt: dto.createdAt,
    decryptState: "ok",
    isRead: false,
    sendStatus: "sending",
    senderUserUuid: dto.senderUserUuid,
  };
  rememberClientMessageKey(dto.messageUuid, clientMessageKey);
  markBirthPending(clientMessageKey);
  messageThreadDecryptCache.setMessage(messageDecryptCacheKey(dto), row);
}

export function useGroupChatThread(params: {
  enabled: boolean;
  conversationUuid: string;
  titleHint?: string;
  meUserUuid: string | undefined;
  dmConversations: readonly MsgConversationDto[];
}) {
  const { enabled, conversationUuid, titleHint, meUserUuid, dmConversations } = params;
  const queryClient = useQueryClient();
  const [group, setGroup] = useState<GroupChat | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [membersBusy, setMembersBusy] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [pendingEpoch, setPendingEpoch] = useState(0);

  const exitToList = useCallback(() => {
    setGroupPendingOutgoing(conversationUuid, null);
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/messages");
  }, [conversationUuid, queryClient]);

  const groupQuery = useQuery({
    queryKey: ["group", conversationUuid],
    enabled: enabled && !!conversationUuid,
    staleTime: 30_000,
    queryFn: () => apiGetGroup(conversationUuid),
    retry: false,
  });

  useEffect(() => {
    if (!enabled) return;
    if (groupQuery.isError) {
      const err = groupQuery.error;
      if (err instanceof ApiRequestError && (err.status === 404 || err.status === 403)) {
        exitToList();
        return;
      }
    }
    const detail = groupQuery.data;
    if (!detail) return;
    setGroup((prev) => {
      const base: GroupChat =
        prev ??
        ({
          conversationUuid,
          title: titleHint?.trim() || detail.title || "Группа",
          createdByUserUuid: detail.createdByUserUuid,
          members: [],
          memberCount: detail.members.length,
          lastMessagePreview: null,
          lastMessageEncryptedWire: null,
          lastMessageAt: null,
          lastMessageIsFromMe: false,
          lastMessageSenderDisplayName: null,
          unreadCount: 0,
          createdAt: detail.createdAt,
        } satisfies GroupChat);
      return mergeGroupDetail(base, detail);
    });
  }, [
    conversationUuid,
    enabled,
    exitToList,
    groupQuery.data,
    groupQuery.error,
    groupQuery.isError,
    titleHint,
  ]);

  // Тот же фетч, которым греет тред prefetch по касанию строки списка (ключ
  // `group-messages` у них общий) — открытие холодной группы идёт одним
  // сетевым полётом, а не вторым запросом поверх прогретого.
  const fetchMessagesPage = useCallback(
    (): Promise<GroupMessagesPage> => fetchThreadFirstPage({ kind: "group", conversationUuid }),
    [conversationUuid],
  );

  const messagesQuery = useQuery({
    queryKey: groupMessagesQueryKey(conversationUuid),
    enabled: enabled && !!conversationUuid,
    staleTime: THREAD_FIRST_PAGE_STALE_MS,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: fetchMessagesPage,
  });

  // Mark-read и тихий догруз живут на экране треда и стартуют после reveal
  // ленты (см. [conversationUuid].tsx): раньше mark-read стрелял здесь ВТОРЫМ
  // дублирующим вызовом прямо в окне открытия.

  const messages = useMemo(() => {
    void pendingEpoch;
    const items = messagesQuery.data?.items ?? [];
    return mergeGroupPendingIntoMessages(conversationUuid, items);
  }, [conversationUuid, messagesQuery.data?.items, pendingEpoch]);

  const refreshRoster = useCallback(async (): Promise<GroupChat | null> => {
    try {
      const detail = await apiGetGroup(conversationUuid);
      let next: GroupChat | null = null;
      setGroup((prev) => {
        const base =
          prev ??
          ({
            conversationUuid,
            title: detail.title || "Группа",
            createdByUserUuid: detail.createdByUserUuid,
            members: [],
            memberCount: detail.members.length,
            lastMessagePreview: null,
            lastMessageEncryptedWire: null,
            lastMessageAt: null,
            lastMessageIsFromMe: false,
            lastMessageSenderDisplayName: null,
            unreadCount: 0,
            createdAt: detail.createdAt,
          } satisfies GroupChat);
        next = mergeGroupDetail(base, detail);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["group", conversationUuid] });
      return next;
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 403)) {
        exitToList();
        return null;
      }
      throw e;
    }
  }, [conversationUuid, exitToList, queryClient]);

  const sendBlocks = useCallback(
    async (
      blocks: FscpMessageBlock[],
      opts?: {
        onPending?: (clientMessageKey: string) => void;
        voiceAssetUuids?: string[];
        imageAssetUuids?: string[];
        replyTo?: FscpMessageReplyRef;
      },
    ): Promise<
      { ok: true; clientMessageKey: string } | { ok: false; restoreDraft?: boolean }
    > => {
      const myUuid = meUserUuid?.trim();
      if (!blocks.length || !myUuid || !conversationUuid) return { ok: false };

      const material = useFscpStore.getState().material;
      if (!material) return { ok: false };
      if (!useFscpStore.getState().canSend()) return { ok: false };

      let roster = group;
      if (groupRosterNeedsRefresh(roster)) {
        roster = await refreshRoster();
      }
      if (!roster) return { ok: false };
      const memberUuids = roster.members.map((m) => m.userUuid).filter(Boolean);
      if (memberUuids.length < 2) {
        Alert.alert("Группа", "Не удалось загрузить участников группы.");
        return { ok: false };
      }

      const clientMessageKey = floraNewUuid();
      const createdAt = new Date().toISOString();
      const pendingDto: MsgMessageDto = {
        messageUuid: clientMessageKey,
        conversationUuid,
        senderUserUuid: myUuid,
        encryptedPayload: optimisticPayloadSentinel(clientMessageKey),
        createdAt,
        isFromMe: true,
        isRead: false,
      };
      seedPendingDecryptRow(pendingDto, blocks, clientMessageKey, opts?.replyTo);
      setGroupPendingOutgoing(conversationUuid, pendingDto);
      setPendingEpoch((n) => n + 1);
      opts?.onPending?.(clientMessageKey);

      try {
        const textOnly =
          blocks.length === 1 && blocks[0]?.kind === "text"
            ? blocks[0].body
            : null;
        const wire =
          textOnly != null
            ? await buildGroupTextMessageWire({
                conversationUuid,
                senderUserUuid: myUuid,
                material,
                memberUserUuids: memberUuids,
                text: textOnly,
                replyTo: opts?.replyTo,
              })
            : await buildGroupBlocksMessageWire({
                conversationUuid,
                senderUserUuid: myUuid,
                material,
                memberUserUuids: memberUuids,
                blocks,
                replyTo: opts?.replyTo,
              });
        const sent = await apiSendGroupMessage(conversationUuid, wire, {
          voiceAssetUuids: opts?.voiceAssetUuids,
          imageAssetUuids: opts?.imageAssetUuids,
        });
        const realDto: MsgMessageDto = {
          messageUuid: sent.messageUuid,
          conversationUuid,
          senderUserUuid: myUuid,
          encryptedPayload: sent.encryptedWire,
          createdAt: sent.createdAt,
          isFromMe: true,
          isRead: false,
        };
        const plain = messagePlaintextFromBlocks(blocks, sent.createdAt);
        if (opts?.replyTo) plain.replyTo = opts.replyTo;
        const ackRow: ThreadBubbleItem = {
          messageUuid: sent.messageUuid,
          clientMessageKey,
          text: extractTextFromPlaintext(plain),
          previewText: plaintextToPreview(plain),
          imageBlocks: getImageBlocksFromPlaintext(plain),
          voiceBlock: getPrimaryVoiceBlock(plain),
          replyTo: opts?.replyTo,
          isFromMe: true,
          createdAt: sent.createdAt,
          decryptState: "ok",
          isRead: false,
          senderUserUuid: myUuid,
        };
        rememberClientMessageKey(sent.messageUuid, clientMessageKey);
        messageThreadDecryptCache.setMessage(messageDecryptCacheKey(realDto), ackRow);
        setGroupPendingOutgoing(conversationUuid, realDto);
        setPendingEpoch((n) => n + 1);
        queryClient.setQueryData<GroupMessagesPage>(
          groupMessagesQueryKey(conversationUuid),
          (old) => {
            const prev = old?.items ?? [];
            const withoutTemp = prev.filter((m) => m.messageUuid !== clientMessageKey);
            if (withoutTemp.some((m) => m.messageUuid === realDto.messageUuid)) {
              return { items: withoutTemp, nextCursor: old?.nextCursor ?? null };
            }
            return { items: [...withoutTemp, realDto], nextCursor: old?.nextCursor ?? null };
          },
        );
        void queryClient.invalidateQueries({ queryKey: ["groups"] });
        void messagesQuery.refetch().then((result) => {
          const items = result.data?.items ?? [];
          if (items.some((m) => m.messageUuid === sent.messageUuid)) {
            setGroupPendingOutgoing(conversationUuid, null);
            setPendingEpoch((n) => n + 1);
          }
        });
        return { ok: true, clientMessageKey };
      } catch (e) {
        setGroupPendingOutgoing(conversationUuid, null);
        setPendingEpoch((n) => n + 1);
        const msg = e instanceof Error ? e.message : "Не удалось отправить сообщение";
        Alert.alert("Отправка", msg);
        return { ok: false, restoreDraft: true };
      }
    },
    [conversationUuid, group, meUserUuid, messagesQuery, queryClient, refreshRoster],
  );

  const sendText = useCallback(
    async (
      text: string,
      opts?: { onPending?: (clientMessageKey: string) => void; replyTo?: FscpMessageReplyRef },
    ): Promise<
      { ok: true; clientMessageKey: string } | { ok: false; restoreDraft?: boolean }
    > => {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false };
      return sendBlocks([{ kind: "text", body: trimmed }], opts);
    },
    [sendBlocks],
  );

  /** Drop pending once server list contains the ACK uuid (SSE / refetch). */
  useEffect(() => {
    if (!enabled) return;
    const pending = getGroupPendingOutgoing(conversationUuid);
    if (!pending) return;
    const items = messagesQuery.data?.items ?? [];
    if (items.some((m) => m.messageUuid === pending.messageUuid)) {
      const clientKey = takeClientMessageKey(pending.messageUuid) ?? pending.messageUuid;
      rememberClientMessageKey(pending.messageUuid, clientKey);
      setGroupPendingOutgoing(conversationUuid, null);
      setPendingEpoch((n) => n + 1);
    }
  }, [conversationUuid, enabled, messagesQuery.data?.items]);

  const leaveGroup = useCallback(() => {
    if (!conversationUuid) return;
    Alert.alert("Выйти из группы?", "Вы больше не будете получать сообщения этой группы.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Выйти",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              await apiLeaveGroup(conversationUuid);
              exitToList();
            } catch (e) {
              if (e instanceof ApiRequestError && (e.status === 404 || e.status === 403)) {
                exitToList();
                return;
              }
              Alert.alert(
                "Не удалось выйти",
                e instanceof Error ? e.message : "Попробуйте ещё раз.",
              );
            }
          })();
        },
      },
    ]);
  }, [conversationUuid, exitToList]);

  const isCreator =
    !!meUserUuid &&
    !!group?.createdByUserUuid &&
    meUserUuid.trim().toLowerCase() === group.createdByUserUuid.trim().toLowerCase();

  const addCandidates = useMemo(() => {
    if (!group) return [] as MsgConversationDto[];
    const memberSet = new Set(group.members.map((m) => m.userUuid.trim().toLowerCase()));
    return dmConversations.filter((c) => {
      const u = c.otherUserUuid.trim().toLowerCase();
      return u && !memberSet.has(u);
    });
  }, [dmConversations, group]);

  const saveTitle = useCallback(
    async (title: string): Promise<boolean> => {
      if (!conversationUuid) return false;
      setMembersBusy(true);
      setMembersError(null);
      try {
        const detail = await apiPatchGroupTitle(conversationUuid, title);
        setGroup((prev) => (prev ? mergeGroupDetail(prev, detail) : prev));
        void queryClient.invalidateQueries({ queryKey: ["groups"] });
        return true;
      } catch (e) {
        setMembersError(e instanceof Error ? e.message : "Не удалось сохранить название.");
        return false;
      } finally {
        setMembersBusy(false);
      }
    },
    [conversationUuid, queryClient],
  );

  const removeMember = useCallback(
    async (userUuid: string): Promise<boolean> => {
      if (!conversationUuid) return false;
      setMembersBusy(true);
      setMembersError(null);
      try {
        await apiRemoveGroupMember(conversationUuid, userUuid);
        setGroup((prev) => {
          if (!prev) return prev;
          const members = prev.members.filter(
            (m) => m.userUuid.trim().toLowerCase() !== userUuid.trim().toLowerCase(),
          );
          return { ...prev, members, memberCount: members.length };
        });
        void queryClient.invalidateQueries({ queryKey: ["groups"] });
        return true;
      } catch (e) {
        setMembersError(e instanceof Error ? e.message : "Не удалось удалить участника.");
        return false;
      } finally {
        setMembersBusy(false);
      }
    },
    [conversationUuid, queryClient],
  );

  const addMember = useCallback(
    async (userUuid: string): Promise<boolean> => {
      if (!conversationUuid) return false;
      setMembersBusy(true);
      setMembersError(null);
      try {
        const gated = await filterMembersWithE2eKeys([userUuid]);
        if (gated.missing.length > 0) {
          setMembersError("У пользователя нет ключей шифрования. Попросите открыть чат на любом клиенте Flora.");
          return false;
        }
        const detail = await apiAddGroupMember(conversationUuid, userUuid);
        setGroup((prev) => (prev ? mergeGroupDetail(prev, detail) : prev));
        void queryClient.invalidateQueries({ queryKey: ["groups"] });
        return true;
      } catch (e) {
        setMembersError(e instanceof Error ? e.message : "Не удалось добавить участника.");
        return false;
      } finally {
        setMembersBusy(false);
      }
    },
    [conversationUuid, queryClient],
  );

  const refetchMessages = useCallback(
    () => messagesQuery.refetch(),
    [messagesQuery],
  );

  const markRead = useCallback(
    () =>
      apiMarkGroupRead(conversationUuid)
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ["groups"] });
          requestTabBadgesRefresh();
        })
        .catch(() => undefined),
    [conversationUuid, queryClient],
  );

  return {
    group,
    members: group?.members ?? EMPTY_MEMBERS,
    memberCount: group?.memberCount || group?.members.length || 0,
    title: (group?.title || titleHint || "Группа").trim() || "Группа",
    messages,
    messagesQuery,
    isLoading: messagesQuery.isLoading || (enabled && groupQuery.isLoading && !group),
    refetchMessages,
    markRead,
    sendText,
    sendBlocks,
    leaveGroup,
    membersOpen,
    setMembersOpen,
    membersBusy,
    membersError,
    isCreator,
    addCandidates,
    saveTitle,
    removeMember,
    addMember,
    refreshRoster,
  };
}
