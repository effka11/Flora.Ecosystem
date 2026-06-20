import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ProfileAvatarEditorModal } from "@/components/profile/ProfileAvatarEditorModal";
import { ProfileCardActions } from "@/components/profile/ProfileCardActions";
import { ProfileCardStatus } from "@/components/profile/ProfileCardStatus";
import { floraColors, floraProfile, floraSpacing } from "@/lib/theme";

/** Временно скрываем статус на карточке профиля (mobile layout в доработке). */
const SHOW_PROFILE_STATUS = false;

const AVATAR_NUDGE_X = (39 - 38) * floraSpacing.grid - 8 + floraSpacing.gridFine * 2;
const TEXT_NUDGE_X = floraSpacing.gridFine * 2;
const STATUS_TOP = 4 * floraSpacing.grid + 4;
/** profile.module.css — .profileDetailsTrigger */
const DETAILS_BTN_SIZE = 8 * floraSpacing.gridFine;
const DETAILS_ICON_SIZE = 4 * floraSpacing.gridFine;

type ProfileCardHeaderProps = {
  displayName: string;
  username: string;
  avatarUuid?: string | null;
  userUuid?: string;
  status?: string | null;
  followersCount?: number;
  followingCount?: number;
  statusLoading?: boolean;
  onSettingsPress?: () => void;
  showDetailsTrigger?: boolean;
  avatarEditable?: boolean;
  actionVariant?: "own" | "other";
  onWritePress?: () => void;
  isFollowing?: boolean;
  followBusy?: boolean;
  onToggleFollow?: () => void;
};

export function ProfileCardHeader({
  displayName,
  username,
  avatarUuid,
  userUuid,
  status,
  followersCount = 0,
  followingCount = 0,
  statusLoading = false,
  onSettingsPress,
  showDetailsTrigger = true,
  avatarEditable = false,
  actionVariant,
  onWritePress,
  isFollowing,
  followBusy,
  onToggleFollow,
}: ProfileCardHeaderProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarCacheVersion, setAvatarCacheVersion] = useState(0);
  const trimmedStatus = (status ?? "").trim();
  const canEditAvatar = avatarEditable || !!onSettingsPress;

  return (
    <View style={styles.root}>
      <View style={styles.cover} />
      <View style={styles.info}>
        <View style={styles.infoTop}>
          <Pressable
            disabled={!canEditAvatar}
            onPress={() => canEditAvatar && setAvatarOpen(true)}
            accessibilityRole={canEditAvatar ? "button" : undefined}
            accessibilityLabel={canEditAvatar ? "Открыть аватар" : undefined}
            style={styles.avatarWrap}
          >
            <FloraAvatar
              size={floraProfile.avatarSize}
              avatarUuid={avatarUuid}
              displayName={displayName}
              username={username}
              seed={userUuid ?? username}
              cacheVersion={avatarCacheVersion}
            />
          </Pressable>
          {SHOW_PROFILE_STATUS ? (
            <ProfileCardStatus status={status} loading={statusLoading} style={styles.status} />
          ) : null}
        </View>

        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.username} numberOfLines={1}>
            @{username || "username"}
          </Text>
        </View>

        <Text style={styles.stats}>
          {followersCount} подписчиков · {followingCount} подписок
        </Text>

        {actionVariant === "own" && onSettingsPress ? (
          <ProfileCardActions variant="own" onEditProfilePress={onSettingsPress} />
        ) : null}
        {actionVariant === "other" && (onWritePress || onToggleFollow) ? (
          <ProfileCardActions
            variant="other"
            onWritePress={onWritePress}
            isFollowing={isFollowing}
            followBusy={followBusy}
            onToggleFollow={onToggleFollow}
          />
        ) : null}

        {showDetailsTrigger ? (
          <View style={styles.detailsBtnWrap} pointerEvents="box-none">
            <Pressable
              onPress={() => setDetailsOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Подробнее о профиле"
              hitSlop={8}
              style={({ pressed }) => [styles.detailsBtn, pressed && styles.detailsBtnPressed]}
            >
              <Ionicons name="chatbox-outline" size={DETAILS_ICON_SIZE} color="rgba(250, 250, 250, 0.7)" />
            </Pressable>
          </View>
        ) : null}
      </View>

      <Modal visible={detailsOpen} transparent animationType="fade" onRequestClose={() => setDetailsOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setDetailsOpen(false)}>
          <Pressable style={styles.modalDialog} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Описание профиля</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Закрыть"
                hitSlop={10}
                onPress={() => setDetailsOpen(false)}
              >
                <Ionicons name="close" size={22} color={floraColors.gray} />
              </Pressable>
            </View>

            <View style={styles.modalBody}>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Имя</Text>
                <Text style={styles.detailValue}>{displayName || "—"}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Юзернейм</Text>
                <Text style={styles.detailValue}>@{username || "—"}</Text>
              </View>
              {trimmedStatus ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Статус</Text>
                  <Text style={styles.detailValue}>{trimmedStatus}</Text>
                </View>
              ) : null}
            </View>

            {onSettingsPress ? (
              <Pressable
                style={({ pressed }) => [styles.editBtn, pressed && styles.editBtnPressed]}
                onPress={() => {
                  setDetailsOpen(false);
                  onSettingsPress();
                }}
              >
                <Text style={styles.editBtnText}>Редактировать профиль</Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {canEditAvatar ? (
        <ProfileAvatarEditorModal
          visible={avatarOpen}
          onClose={() => setAvatarOpen(false)}
          displayName={displayName}
          username={username}
          userUuid={userUuid}
          avatarUuid={avatarUuid}
          cacheVersion={avatarCacheVersion}
          onAvatarChanged={() => setAvatarCacheVersion((v) => v + 1)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
    borderRadius: 12,
    backgroundColor: floraColors.accentDark,
  },
  info: {
    position: "relative",
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: floraSpacing.grid,
    marginTop: floraProfile.coverHeight - floraSpacing.grid * 3,
    paddingRight: DETAILS_BTN_SIZE + floraSpacing.grid * 2,
  },
  infoTop: {
    position: "relative",
    minHeight: floraProfile.avatarSize,
    marginBottom: floraSpacing.gridFine,
  },
  avatarWrap: {
    position: "absolute",
    left: AVATAR_NUDGE_X,
    top: -4,
    borderWidth: 4,
    borderColor: floraColors.bg,
    borderRadius: floraProfile.avatarSize / 2 + 4,
    overflow: "hidden",
  },
  status: {
    position: "absolute",
    left: floraProfile.avatarSize + floraSpacing.grid,
    right: 0,
    top: STATUS_TOP,
    transform: [{ translateX: -floraSpacing.grid }],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: floraSpacing.grid,
    paddingLeft: TEXT_NUDGE_X,
    marginTop: floraSpacing.gridFine,
  },
  name: {
    color: floraColors.whiteTemplate,
    fontSize: 20,
    fontWeight: "300",
    letterSpacing: 0.6,
  },
  username: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  stats: {
    color: floraColors.gray,
    paddingLeft: TEXT_NUDGE_X,
    marginTop: floraSpacing.gridFine + 2,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
  detailsBtnWrap: {
    position: "absolute",
    right: floraSpacing.grid * 2,
    bottom: floraSpacing.grid,
  },
  detailsBtn: {
    width: DETAILS_BTN_SIZE,
    height: DETAILS_BTN_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.12)",
    borderRadius: DETAILS_BTN_SIZE / 2,
    backgroundColor: "transparent",
  },
  detailsBtnPressed: {
    borderColor: "rgba(164, 209, 138, 0.3)",
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
    maxWidth: 560,
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
    fontSize: 18,
    fontWeight: "300",
  },
  modalBody: {
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid,
    gap: floraSpacing.gridFine * 2,
  },
  detailRow: {
    gap: floraSpacing.gridFine,
  },
  detailLabel: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
  },
  detailValue: {
    color: floraColors.whiteTemplate,
    fontSize: 14,
    fontWeight: "300",
  },
  editBtn: {
    marginHorizontal: floraSpacing.grid,
    marginBottom: floraSpacing.grid,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(164, 209, 138, 0.4)",
    borderRadius: floraSpacing.gridFine * 2,
  },
  editBtnPressed: {
    backgroundColor: "rgba(164, 209, 138, 0.1)",
  },
  editBtnText: {
    color: floraColors.greenLight,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
});
