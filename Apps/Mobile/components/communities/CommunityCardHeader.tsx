import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { CommunityRole } from "@flora/client-core/contracts";
import { FloraAvatar } from "@/components/FloraAvatar";
import { CommunityCardActions } from "@/components/communities/CommunityCardActions";
import { useSPx } from "@/lib/FloraGridProvider";
import { floraColors, floraProfile, floraSpacing, kegl, sPx, tracking } from "@/lib/theme";

const AVATAR_NUDGE_X = () => (39 - 38) * floraSpacing.grid - sPx(8) + floraSpacing.gridFine * 2;
const TEXT_NUDGE_X = () => floraSpacing.gridFine * 2;

type CommunityCardHeaderProps = {
  name: string;
  communityId: string;
  slug: string;
  avatarUuid?: string | null;
  memberCount: number;
  isPrivate?: boolean;
  role?: CommunityRole | null;
  loading?: boolean;
  membershipBusy?: boolean;
  membershipError?: string | null;
  onComposePress?: () => void;
  onSettingsPress?: () => void;
  onSubscribePress?: () => void;
  onUnsubscribePress?: () => void;
};

export function CommunityCardHeader({
  name,
  communityId,
  slug,
  avatarUuid,
  memberCount,
  isPrivate,
  role,
  loading = false,
  membershipBusy,
  membershipError,
  onComposePress,
  onSettingsPress,
  onSubscribePress,
  onUnsubscribePress,
}: CommunityCardHeaderProps) {
  const sp = useSPx();
  const [membersOpen, setMembersOpen] = useState(false);
  const membersLabel = memberCount.toLocaleString("ru-RU");

  return (
    <View style={styles.root}>
      <View style={styles.cover} />
      <View style={styles.info}>
        <View style={styles.infoTop}>
          <View style={styles.avatarWrap}>
            <FloraAvatar
              size={floraProfile.avatarSize}
              avatarUuid={avatarUuid}
              displayName={name}
              communityName={name}
              username={slug}
              seed={communityId}
            />
          </View>
        </View>

        <View style={styles.nameRow}>
          {loading ? (
            <ActivityIndicator color={floraColors.greenLight} style={styles.nameLoader} />
          ) : (
            <Text style={styles.name} numberOfLines={2}>
              {name || slug}
            </Text>
          )}
          {isPrivate === true ? (
            <View style={styles.privateBadge}>
              <Text style={styles.privateBadgeText}>Закрытое</Text>
            </View>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Показать участников"
          onPress={() => setMembersOpen(true)}
          style={({ pressed }) => [styles.statsPressable, pressed && styles.statsPressed]}
        >
          <Text style={styles.stats}>
            <Text style={styles.statsStrong}>{membersLabel}</Text> участников
          </Text>
        </Pressable>

        <CommunityCardActions
          role={role}
          membershipBusy={membershipBusy}
          membershipError={membershipError}
          onComposePress={onComposePress}
          onSettingsPress={onSettingsPress}
          onSubscribePress={onSubscribePress}
          onUnsubscribePress={onUnsubscribePress}
        />
      </View>

      <Modal visible={membersOpen} transparent animationType="fade" onRequestClose={() => setMembersOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setMembersOpen(false)}>
          <Pressable style={styles.modalDialog} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Участники</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Закрыть"
                hitSlop={sp(10)}
                onPress={() => setMembersOpen(false)}
              >
                <Ionicons name="close" size={sp(22)} color={floraColors.gray} />
              </Pressable>
            </View>
            <Text style={styles.modalBody}>Список участников появится позже.</Text>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  root: {
    position: "relative",
    paddingTop: floraSpacing.grid,
    paddingBottom: floraSpacing.grid,
    borderBottomWidth: 1,
    borderBottomColor: floraProfile.statusStripe,
  },
  cover: {
    position: "absolute",
    left: floraSpacing.grid,
    right: floraSpacing.grid,
    top: floraSpacing.grid,
    height: floraProfile.coverHeight,
    borderRadius: sPx(12),
    backgroundColor: floraColors.accentDark,
  },
  info: {
    position: "relative",
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: floraSpacing.grid,
    marginTop: floraProfile.coverHeight - floraSpacing.grid * 3,
  },
  infoTop: {
    position: "relative",
    minHeight: floraProfile.avatarSize,
    marginBottom: floraSpacing.gridFine,
  },
  avatarWrap: {
    position: "absolute",
    left: AVATAR_NUDGE_X(),
    top: -sPx(4),
    borderWidth: sPx(4),
    borderColor: floraColors.bg,
    borderRadius: floraProfile.avatarSize / 2 + sPx(4),
    overflow: "hidden",
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: floraSpacing.gridFine * 2,
    paddingLeft: TEXT_NUDGE_X(),
    marginTop: floraSpacing.gridFine,
    minHeight: sPx(28),
  },
  nameLoader: {
    alignSelf: "flex-start",
  },
  name: {
    flexShrink: 1,
    color: floraColors.whiteTemplate,
    fontSize: kegl(20),
    fontWeight: "300",
    letterSpacing: tracking(0.6),
  },
  privateBadge: {
    borderWidth: 1,
    borderColor: "rgba(164, 209, 138, 0.35)",
    borderRadius: floraSpacing.gridFine,
    paddingHorizontal: floraSpacing.gridFine * 2,
    paddingVertical: sPx(2),
  },
  privateBadgeText: {
    color: floraColors.greenLight,
    fontSize: kegl(12),
    fontWeight: "300",
  },
  statsPressable: {
    alignSelf: "flex-start",
    paddingLeft: TEXT_NUDGE_X(),
    marginTop: floraSpacing.gridFine + sPx(2),
  },
  statsPressed: {
    opacity: 0.75,
  },
  stats: {
    color: floraColors.gray,
    fontSize: kegl(14),
    fontWeight: "300",
    letterSpacing: tracking(0.42),
  },
  statsStrong: {
    color: floraColors.whiteTemplate,
    fontWeight: "400",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.65)",
    alignItems: "center",
    justifyContent: "center",
    padding: floraSpacing.grid * 2,
  },
  modalDialog: {
    width: "100%",
    maxWidth: sPx(560),
    borderRadius: floraSpacing.grid,
    backgroundColor: floraColors.surface,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.12)",
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid,
    borderBottomWidth: 1,
    borderBottomColor: floraProfile.statusStripe,
  },
  modalTitle: {
    color: floraColors.whiteTemplate,
    fontSize: kegl(18),
    fontWeight: "300",
  },
  modalBody: {
    color: floraColors.gray,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid * 2,
    fontSize: kegl(14),
    fontWeight: "300",
    letterSpacing: tracking(0.42),
  },
}));
