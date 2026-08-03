import { Ionicons } from "@expo/vector-icons";
import { PRESENCE_TYPING_PEER_TTL_MS, sharedPresenceStore } from "@flora/client-core/presence";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ChromeBackIcon, ChromeMoreIcon } from "@/components/chrome/ChromeIcons";
import { OnlineStatusDot } from "@/components/messages/OnlineStatusDot";
import { formatWasOnlineRu } from "@/lib/lastSeenRu";
import { profileScreenHref } from "@/lib/socialRoutes";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import { subscribeTyping } from "@/lib/typingEvents";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { useSessionStore } from "@/stores/sessionStore";

const TYPING_DOTS_STEP_MS = 400;

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
  moreMenuOpen?: boolean;
  moreButtonRef?: React.RefObject<View | null>;
};

export function ChatThreadHeader({ peer, onMorePress, moreMenuOpen = false, moreButtonRef }: Props) {
  const insets = useSafeAreaInsets();
  const me = useSessionStore((s) => s.me);
  const displayName = peer.otherDisplayName || peer.otherUsername || "Пользователь";
  const username = peer.otherUsername.replace(/^@+/, "") || "…";
  const [presenceClock, setPresenceClock] = useState(0);
  const [presenceTick, setPresenceTick] = useState(0);
  const [presenceEpoch, setPresenceEpoch] = useState(() => sharedPresenceStore.getSessionEpoch());
  const [peerTyping, setPeerTyping] = useState(false);
  const [typingDots, setTypingDots] = useState(1);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const id = setInterval(() => setPresenceClock((c) => c + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!peerTyping || reduceMotion) {
      setTypingDots(3);
      return undefined;
    }
    setTypingDots(1);
    const id = setInterval(() => {
      setTypingDots((n) => (n >= 3 ? 1 : n + 1));
    }, TYPING_DOTS_STEP_MS);
    return () => clearInterval(id);
  }, [peerTyping, reduceMotion]);

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
    const conv = peer.conversationUuid?.trim().toLowerCase();
    const other = peer.otherUserUuid?.trim().toLowerCase();
    if (!conv || !other) return undefined;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeTyping((detail) => {
      if (detail.conversationUuid.trim().toLowerCase() !== conv) return;
      if (detail.userUuid.trim().toLowerCase() !== other) return;
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = null;
      setPeerTyping(detail.isTyping);
      if (detail.isTyping) {
        clearTimer = setTimeout(() => {
          clearTimer = null;
          setPeerTyping(false);
        }, PRESENCE_TYPING_PEER_TTL_MS);
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
    if (peerTyping) return `Печатает${".".repeat(typingDots)}`;
    if (overlay.isOnline) return "В сети";
    const was = formatWasOnlineRu(overlay.lastSeenAt, new Date());
    return was ?? "Не в сети";
  }, [overlay.isOnline, overlay.lastSeenAt, presenceClock, presenceTick, peerTyping, typingDots]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + floraSpacing.grid }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Назад к списку чатов"
        style={({ pressed }) => [styles.backBtn, pressed && styles.backBtnPressed]}
        onPress={() => router.back()}
      >
        <ChromeBackIcon color={floraColors.gray} />
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
        <Text
          style={styles.status}
          numberOfLines={1}
          accessibilityLabel={peerTyping ? "Собеседник печатает" : presenceLine}
        >
          {presenceLine}
        </Text>
      </View>

      <View ref={moreButtonRef} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={moreMenuOpen ? "Закрыть меню чата" : "Меню чата"}
          accessibilityState={{ expanded: moreMenuOpen }}
          style={({ pressed }) => [styles.moreBtn, pressed && styles.moreBtnPressed]}
          onPress={onMorePress}
          hitSlop={8}
        >
          {moreMenuOpen ? (
            <Ionicons name="close-outline" size={24} color={floraColors.gray} />
          ) : (
            <ChromeMoreIcon color={floraColors.gray} />
          )}
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
    /** Нижний зазор чуть меньше полной 8-й клетки (−16px), контент не смещается. */
    minHeight: floraMessages.headerHeight - 20,
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
  /** Как `iconButton` / ⋮ при выделении в TabScreenSearchHeader — центр под «+». */
  moreBtn: {
    width: 45,
    height: 45,
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
