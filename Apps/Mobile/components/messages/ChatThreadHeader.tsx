import { Ionicons } from "@expo/vector-icons";
import { sharedPresenceStore } from "@flora/client-core/presence";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { OnlineStatusDot } from "@/components/messages/OnlineStatusDot";
import { formatWasOnlineRu } from "@/lib/lastSeenRu";
import { profileScreenHref } from "@/lib/socialRoutes";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import { subscribeTyping } from "@/lib/typingEvents";
import { useSessionStore } from "@/stores/sessionStore";

export type ChatPeerInfo = {
  otherUserUuid: string;
  otherUsername: string;
  otherDisplayName: string;
  otherAvatarUuid: string | null;
  otherUserIsOnline: boolean;
  otherUserLastSeenAt: string | null;
  conversationUuid?: string | null;
};

type Props = {
  peer: ChatPeerInfo;
  onMorePress: () => void;
  moreButtonRef?: React.RefObject<View | null>;
};

export function ChatThreadHeader({ peer, onMorePress, moreButtonRef }: Props) {
  const insets = useSafeAreaInsets();
  const me = useSessionStore((s) => s.me);
  const displayName = peer.otherDisplayName || peer.otherUsername || "Пользователь";
  const username = peer.otherUsername.replace(/^@+/, "") || "…";
  const [presenceClock, setPresenceClock] = useState(0);
  const [presenceTick, setPresenceTick] = useState(0);
  const [presenceEpoch, setPresenceEpoch] = useState(() => sharedPresenceStore.getSessionEpoch());
  const [peerTyping, setPeerTyping] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setPresenceClock((c) => c + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(
    () =>
      sharedPresenceStore.subscribe(() => {
        setPresenceTick((n) => n + 1);
        setPresenceEpoch(sharedPresenceStore.getSessionEpoch());
      }),
    [],
  );

  useEffect(() => {
    if (!sharedPresenceStore.surfacesAccepted) {
      return () => sharedPresenceStore.unregisterSurface("chat-header");
    }
    sharedPresenceStore.registerSurface("chat-header", [peer.otherUserUuid]);
    void sharedPresenceStore.resyncSnapshots().catch(() => {});
    return () => sharedPresenceStore.unregisterSurface("chat-header");
  }, [peer.otherUserUuid, presenceEpoch]);

  useEffect(() => {
    if (!peer.conversationUuid) return undefined;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeTyping((detail) => {
      if (detail.conversationUuid !== peer.conversationUuid) return;
      if (detail.userUuid !== peer.otherUserUuid) return;
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = null;
      setPeerTyping(detail.isTyping);
      if (detail.isTyping) {
        clearTimer = setTimeout(() => {
          clearTimer = null;
          setPeerTyping(false);
        }, 3000);
      }
    });
    return () => {
      unsub();
      if (clearTimer) clearTimeout(clearTimer);
      setPeerTyping(false);
    };
  }, [peer.conversationUuid, peer.otherUserUuid]);

  const overlay = sharedPresenceStore.overlayOnline(
    peer.otherUserUuid,
    peer.otherUserIsOnline,
    peer.otherUserLastSeenAt,
  );

  const presenceLine = useMemo(() => {
    void presenceTick;
    if (peerTyping) return "печатает…";
    if (overlay.isOnline) return "В сети";
    const was = formatWasOnlineRu(overlay.lastSeenAt, new Date());
    return was ?? "Не в сети";
  }, [overlay.isOnline, overlay.lastSeenAt, presenceClock, presenceTick, peerTyping]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + floraSpacing.gridFine }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Назад к списку чатов"
        style={({ pressed }) => [styles.backBtn, pressed && styles.backBtnPressed]}
        onPress={() => router.back()}
      >
        <Ionicons name="chevron-back" size={22} color={floraColors.gray} />
      </Pressable>

      <View style={styles.avatarWrap}>
        <FloraAvatar
          size={floraMessages.headerAvatarSize}
          avatarUuid={peer.otherAvatarUuid}
          displayName={displayName}
          username={peer.otherUsername}
          seed={peer.otherUserUuid}
          href={username !== "…" ? profileScreenHref(username, me?.username) : undefined}
        />
        <OnlineStatusDot
          key={peer.otherUserUuid}
          identityKey={peer.otherUserUuid}
          online={overlay.isOnline}
        />
      </View>

      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.handle} numberOfLines={1}>
            @{username}
          </Text>
        </View>
        <Text style={styles.status} numberOfLines={1}>
          {presenceLine}
        </Text>
      </View>

      <View ref={moreButtonRef} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Меню чата"
          style={({ pressed }) => [styles.moreBtn, pressed && styles.moreBtnPressed]}
          onPress={onMorePress}
          hitSlop={8}
        >
          <Ionicons name="ellipsis-vertical" size={18} color={floraColors.gray} />
        </Pressable>
      </View>

      <View style={styles.divider} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    /** 7×15px: без нижней «мёртвой» 8-й клетки (на web она прозрачная под заход ленты). */
    minHeight: floraMessages.headerHeight - floraSpacing.grid,
    paddingBottom: floraSpacing.grid,
    paddingHorizontal: floraSpacing.grid,
    backgroundColor: floraColors.bg,
  },
  backBtn: {
    width: floraSpacing.grid * 2,
    height: floraSpacing.grid * 2,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -floraSpacing.gridFine,
  },
  backBtnPressed: {
    opacity: 0.72,
  },
  avatarWrap: {
    position: "relative",
    width: floraMessages.headerAvatarSize,
    height: floraMessages.headerAvatarSize,
    flexShrink: 0,
  },
  info: {
    flex: 1,
    minWidth: 0,
    gap: floraSpacing.gridFine,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: floraSpacing.gridFine * 2,
    minWidth: 0,
  },
  name: {
    flexShrink: 1,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  handle: {
    flexShrink: 0,
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  status: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  moreBtn: {
    width: floraSpacing.gridFine * 2 + 18,
    height: floraSpacing.gridFine * 2 + 18,
    alignItems: "center",
    justifyContent: "center",
  },
  moreBtnPressed: {
    opacity: 0.72,
  },
  divider: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    backgroundColor: floraMessages.divider,
  },
});
