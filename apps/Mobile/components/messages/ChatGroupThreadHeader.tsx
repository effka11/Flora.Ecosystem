import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ChromeBackIcon, ChromeMoreIcon } from "@/components/chrome/ChromeIcons";
import { formatGroupMembersLabel } from "@/lib/groupChatTypes";
import { useSPx } from "@/lib/FloraGridProvider";
import { floraColors, floraMessages, floraSpacing, kegl, tracking } from "@/lib/theme";

type Props = {
  title: string;
  conversationUuid: string;
  memberCount: number;
  onMembersPress: () => void;
  onMorePress: () => void;
  moreMenuOpen?: boolean;
  moreButtonRef?: React.RefObject<View | null>;
};

/** Same chrome as ChatThreadHeader — back, avatar, title+subtitle, more, divider. */
export function ChatGroupThreadHeader({
  title,
  conversationUuid,
  memberCount,
  onMembersPress,
  onMorePress,
  moreMenuOpen = false,
  moreButtonRef,
}: Props) {
  const insets = useSafeAreaInsets();
  const sp = useSPx();
  const label = title.trim() || "Группа";
  const subtitle = formatGroupMembersLabel(memberCount);

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

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${subtitle}`}
        style={({ pressed }) => [styles.peerHit, pressed && styles.peerHitPressed]}
        onPress={onMembersPress}
      >
        <View style={styles.avatarWrap}>
          <FloraAvatar
            size={floraMessages.headerAvatarSize}
            displayName={label}
            seed={conversationUuid}
          />
        </View>

        <View style={styles.info}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {label}
            </Text>
          </View>
          <Text style={styles.status} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </Pressable>

      <View ref={moreButtonRef} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={moreMenuOpen ? "Закрыть меню группы" : "Меню группы"}
          accessibilityState={{ expanded: moreMenuOpen }}
          style={({ pressed }) => [styles.moreBtn, pressed && styles.moreBtnPressed]}
          onPress={onMorePress}
          hitSlop={sp(8)}
        >
          {moreMenuOpen ? (
            <Ionicons name="close-outline" size={sp(24)} color={floraColors.gray} />
          ) : (
            <ChromeMoreIcon color={floraColors.gray} />
          )}
        </Pressable>
      </View>

      <View style={styles.divider} pointerEvents="none" />
    </View>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  root: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    minHeight: floraMessages.headerHeight - 4 * floraSpacing.gridFine,
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
  peerHit: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    minWidth: 0,
  },
  peerHitPressed: {
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
    fontSize: kegl(15),
    fontWeight: "300",
    letterSpacing: tracking(0.45),
    lineHeight: 4 * floraSpacing.gridFine,
  },
  status: {
    color: floraColors.gray,
    fontSize: kegl(15),
    fontWeight: "300",
    letterSpacing: tracking(0.45),
    lineHeight: 4 * floraSpacing.gridFine,
  },
  /** Как `iconButton` / ⋮ при выделении в TabScreenSearchHeader — центр под «+». */
  moreBtn: {
    width: 3 * floraSpacing.grid,
    height: 3 * floraSpacing.grid,
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
}));
