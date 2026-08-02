import type { MsgConversationDto } from "@flora/client-core/contracts";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { floraColors, floraSpacing } from "@/lib/theme";

export type CreateChatFolderResult = {
  name: string;
  icon: keyof typeof Ionicons.glyphMap;
  memberUserUuids: string[];
};

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Кандидаты из списка чатов. */
  conversations: readonly MsgConversationDto[];
  onCreate?: (result: CreateChatFolderResult) => void;
};

const FOLDER_ICONS: readonly (keyof typeof Ionicons.glyphMap)[] = [
  "folder-outline",
  "briefcase-outline",
  "heart-outline",
  "star-outline",
  "flash-outline",
  "home-outline",
  "game-controller-outline",
  "musical-notes-outline",
  "airplane-outline",
  "cafe-outline",
  "book-outline",
  "construct-outline",
];

/** Sheet создания папки списка чатов (после развилки «+»). */
export function CreateChatFolderSheet({ visible, onClose, conversations, onCreate }: Props) {
  const insets = useSafeAreaInsets();
  const [folderIcon, setFolderIcon] = useState<(typeof FOLDER_ICONS)[number]>("folder-outline");
  const [folderName, setFolderName] = useState("");
  const [selectedUserUuids, setSelectedUserUuids] = useState<Set<string>>(() => new Set());
  const [userSearch, setUserSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setFolderIcon("folder-outline");
    setFolderName("");
    setSelectedUserUuids(new Set());
    setUserSearch("");
    setError(null);
  }, [visible]);

  const candidates = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    const list = conversations.filter((c) => c.otherUserUuid);
    if (!q) return list;
    return list.filter((c) => {
      const name = (c.otherDisplayName || "").toLowerCase();
      const user = (c.otherUsername || "").toLowerCase();
      return name.includes(q) || user.includes(q);
    });
  }, [conversations, userSearch]);

  const toggleUser = (userUuid: string) => {
    setSelectedUserUuids((prev) => {
      const next = new Set(prev);
      if (next.has(userUuid)) next.delete(userUuid);
      else next.add(userUuid);
      return next;
    });
    setError(null);
  };

  const submit = () => {
    const members = [...selectedUserUuids];
    if (members.length === 0) {
      setError("Выберите хотя бы одного пользователя для папки.");
      return;
    }
    onCreate?.({
      name: folderName.trim() || "Папка",
      icon: folderIcon,
      memberUserUuids: members,
    });
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View
        style={[
          styles.root,
          {
            paddingTop: insets.top + floraSpacing.grid,
            paddingBottom: insets.bottom + floraSpacing.grid,
          },
        ]}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть"
            style={styles.headerSide}
            onPress={onClose}
          >
            <Ionicons name="close" size={24} color={floraColors.gray} />
          </Pressable>
          <Text style={styles.title}>Новая папка</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Создать"
            style={[styles.headerSide, styles.headerAction]}
            onPress={submit}
          >
            <Text style={styles.headerActionText}>Создать</Text>
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.section}>
            <Text style={styles.label}>Название</Text>
            <TextInput
              style={styles.input}
              placeholder="Например, Работа"
              placeholderTextColor={floraColors.gray}
              value={folderName}
              onChangeText={(value) => {
                setFolderName(value);
                setError(null);
              }}
              maxLength={40}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Иконка</Text>
            <View style={styles.iconGrid}>
              {FOLDER_ICONS.map((icon) => {
                const active = folderIcon === icon;
                return (
                  <Pressable
                    key={icon}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.iconCell, active && styles.iconCellActive]}
                    onPress={() => setFolderIcon(icon)}
                  >
                    <Ionicons
                      name={icon}
                      size={22}
                      color={active ? floraColors.greenLight : floraColors.gray}
                    />
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Чаты в папке</Text>
            <TextInput
              style={styles.input}
              placeholder="Поиск по имени или @username"
              placeholderTextColor={floraColors.gray}
              value={userSearch}
              onChangeText={setUserSearch}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.userList}>
              {candidates.length === 0 ? (
                <Text style={styles.emptyUsers}>
                  {conversations.length === 0
                    ? "Пока нет чатов — найдите людей во вкладке «Люди»."
                    : "Никого не найдено."}
                </Text>
              ) : (
                candidates.map((c) => {
                  const selected = selectedUserUuids.has(c.otherUserUuid);
                  const displayName = c.otherDisplayName || c.otherUsername;
                  return (
                    <Pressable
                      key={c.otherUserUuid}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      style={[styles.userRow, selected && styles.userRowSelected]}
                      onPress={() => toggleUser(c.otherUserUuid)}
                    >
                      <FloraAvatar
                        size={36}
                        avatarUuid={c.otherAvatarUuid}
                        displayName={displayName}
                        username={c.otherUsername}
                        seed={c.otherUserUuid}
                      />
                      <View style={styles.userMeta}>
                        <Text style={styles.userName} numberOfLines={1}>
                          {displayName}
                        </Text>
                        <Text style={styles.userHandle} numberOfLines={1}>
                          @{c.otherUsername.replace(/^@+/, "")}
                        </Text>
                      </View>
                      <Ionicons
                        name={selected ? "checkmark-circle" : "ellipse-outline"}
                        size={22}
                        color={selected ? floraColors.greenLight : floraColors.gray}
                      />
                    </Pressable>
                  );
                })
              )}
            </View>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
    paddingHorizontal: floraSpacing.grid,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: floraSpacing.grid * 2,
  },
  headerSide: {
    width: 72,
    minHeight: 36,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  headerAction: {
    alignItems: "flex-end",
  },
  headerActionText: {
    color: floraColors.greenLight,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 16,
    fontWeight: "300",
    letterSpacing: 0.48,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: floraSpacing.grid * 2,
    paddingBottom: floraSpacing.grid * 2,
  },
  section: {
    gap: floraSpacing.gridFine * 2,
  },
  label: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  input: {
    minHeight: 45,
    borderColor: floraColors.greenDark,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  iconGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: floraSpacing.gridFine,
  },
  iconCell: {
    width: 48,
    height: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
    backgroundColor: "rgba(250, 250, 250, 0.03)",
  },
  iconCellActive: {
    borderColor: "rgba(164, 209, 138, 0.45)",
    backgroundColor: "rgba(164, 209, 138, 0.12)",
  },
  userList: {
    gap: floraSpacing.gridFine,
  },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 1.5,
    paddingHorizontal: floraSpacing.gridFine * 2,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "transparent",
  },
  userRowSelected: {
    borderColor: "rgba(164, 209, 138, 0.28)",
    backgroundColor: "rgba(164, 209, 138, 0.08)",
  },
  userMeta: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  userName: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  userHandle: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  emptyUsers: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
    lineHeight: 20,
    paddingVertical: floraSpacing.grid,
  },
  error: {
    color: floraColors.error,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
    lineHeight: 20,
  },
});
