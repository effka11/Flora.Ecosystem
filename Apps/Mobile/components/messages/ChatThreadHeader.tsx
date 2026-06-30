import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { formatWasOnlineRu } from "@/lib/lastSeenRu";
import { profileScreenHref } from "@/lib/socialRoutes";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";

export type ChatPeerInfo = {
  otherUserUuid: string;
  otherUsername: string;
  otherDisplayName: string;
  otherAvatarUuid: string | null;
  otherUserIsOnline: boolean;
  otherUserLastSeenAt: string | null;
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

  useEffect(() => {
    const id = setInterval(() => setPresenceClock((c) => c + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const presenceLine = useMemo(() => {
    if (peer.otherUserIsOnline) return "В сети";
    const was = formatWasOnlineRu(peer.otherUserLastSeenAt, new Date());
    return was ?? "Не в сети";
  }, [peer.otherUserIsOnline, peer.otherUserLastSeenAt, presenceClock]);

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
        {peer.otherUserIsOnline ? <View style={styles.onlineBadge} /> : null}
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
    minHeight: floraMessages.headerHeight,
    paddingBottom: floraSpacing.grid * 2,
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
  onlineBadge: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 15,
    height: 15,
    borderRadius: 8,
    backgroundColor: floraColors.greenLight,
    borderWidth: 3,
    borderColor: floraColors.bg,
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
    bottom: floraSpacing.grid,
    height: 1,
    backgroundColor: floraMessages.divider,
  },
});
