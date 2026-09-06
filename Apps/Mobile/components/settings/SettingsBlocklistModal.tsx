import { liveGridStyles } from "@/lib/liveGridStyles";
import { apiBlockUser, apiGetBlocklist, apiUnblockUser } from "@flora/client-core/api";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import { floraColors, floraSpacing } from "@/lib/theme";

type BlocklistEntry = {
  userUuid: string;
  username: string;
  displayName: string;
};

function parseBlocklist(raw: unknown): BlocklistEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: BlocklistEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const userUuid =
      (typeof row.userUuid === "string" && row.userUuid) ||
      (typeof row.UserUuid === "string" && row.UserUuid) ||
      "";
    if (!userUuid) continue;
    const username =
      (typeof row.username === "string" && row.username) ||
      (typeof row.Username === "string" && row.Username) ||
      "";
    const displayName =
      (typeof row.displayName === "string" && row.displayName) ||
      (typeof row.DisplayName === "string" && row.DisplayName) ||
      "";
    out.push({ userUuid, username, displayName });
  }
  return out;
}

type SettingsBlocklistModalProps = {
  visible: boolean;
  onClose: () => void;
};

export function SettingsBlocklistModal({ visible, onClose }: SettingsBlocklistModalProps) {
  const [entries, setEntries] = useState<BlocklistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [busyUsername, setBusyUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadBlocklist = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(parseBlocklist(await apiGetBlocklist()));
    } catch (e) {
      setEntries([]);
      setError(e instanceof Error ? e.message : "Не удалось загрузить чёрный список.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setUsernameInput("");
    setError(null);
    void loadBlocklist();
  }, [loadBlocklist, visible]);

  const handleBlock = async () => {
    const username = usernameInput.trim().replace(/^@+/, "");
    if (!username) {
      setError("Укажите юзернейм.");
      return;
    }
    setBusyUsername(username);
    setError(null);
    try {
      await apiBlockUser(username);
      setUsernameInput("");
      await loadBlocklist();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось заблокировать пользователя.");
    } finally {
      setBusyUsername(null);
    }
  };

  const handleUnblock = async (username: string) => {
    const nick = username.trim().replace(/^@+/, "");
    if (!nick) return;
    setBusyUsername(nick);
    setError(null);
    try {
      await apiUnblockUser(nick);
      await loadBlocklist();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось разблокировать пользователя.");
    } finally {
      setBusyUsername(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.header}>
            <Text style={styles.title}>Чёрный список</Text>
            <Pressable
              style={({ pressed }) => [styles.closeBtn, pressed && ui.pressed]}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
            >
              <Ionicons name="close" size={22} color={floraColors.gray} />
            </Pressable>
          </View>

          <Text style={styles.body}>
            Заблокированные пользователи не смогут просматривать ваш профиль и писать вам сообщения.
          </Text>

          <View style={styles.addRow}>
            <TextInput
              style={[ui.input, styles.addInput]}
              value={usernameInput}
              onChangeText={setUsernameInput}
              placeholder="Юзернейм"
              placeholderTextColor="rgba(250, 250, 250, 0.3)"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              style={({ pressed }) => [styles.addBtn, pressed && ui.pressed]}
              onPress={() => void handleBlock()}
              disabled={busyUsername !== null}
            >
              {busyUsername && busyUsername === usernameInput.trim().replace(/^@+/, "") ? (
                <ActivityIndicator color={floraColors.bg} />
              ) : (
                <Text style={styles.addBtnText}>Блок</Text>
              )}
            </Pressable>
          </View>

          {error ? <Text style={ui.feedbackError}>{error}</Text> : null}

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {loading ? (
              <ActivityIndicator color={floraColors.greenLight} style={styles.loader} />
            ) : entries.length === 0 ? (
              <Text style={styles.empty}>Список пуст.</Text>
            ) : (
              entries.map((entry) => {
                const nick = entry.username.replace(/^@+/, "");
                const label = entry.displayName || nick || "Пользователь";
                const busy = busyUsername === nick;
                return (
                  <View key={entry.userUuid} style={styles.row}>
                    <View style={styles.rowCopy}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {label}
                      </Text>
                      {nick ? (
                        <Text style={styles.rowMeta} numberOfLines={1}>
                          @{nick}
                        </Text>
                      ) : null}
                    </View>
                    <Pressable
                      style={({ pressed }) => [styles.unblockBtn, pressed && ui.pressed]}
                      onPress={() => void handleUnblock(nick)}
                      disabled={busy || !nick}
                    >
                      {busy ? (
                        <ActivityIndicator color="#f6a8a8" />
                      ) : (
                        <Text style={styles.unblockText}>Разблок.</Text>
                      )}
                    </Pressable>
                  </View>
                );
              })
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    justifyContent: "center",
    paddingHorizontal: floraSpacing.grid * 2,
  },
  card: {
    maxHeight: "80%",
    borderRadius: floraSpacing.grid,
    backgroundColor: floraColors.surfaceElevated,
    borderWidth: 1,
    borderColor: floraColors.border,
    padding: floraSpacing.grid * 2,
    gap: floraSpacing.grid,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  title: {
    flex: 1,
    color: floraColors.whiteTemplate,
    fontSize: 18,
    fontWeight: "300",
    letterSpacing: 0.54,
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    lineHeight: 20,
  },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine * 2,
  },
  addInput: {
    flex: 1,
    minWidth: 0,
  },
  addBtn: {
    minWidth: 72,
    height: floraSpacing.grid * 3,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: floraColors.greenLight,
    paddingHorizontal: floraSpacing.grid,
  },
  addBtnText: {
    color: floraColors.bg,
    fontSize: 14,
    fontWeight: "400",
  },
  list: {
    maxHeight: 280,
  },
  loader: {
    marginVertical: floraSpacing.grid * 2,
  },
  empty: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    paddingVertical: floraSpacing.grid,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
  },
  rowMeta: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
  },
  unblockBtn: {
    minWidth: 88,
    minHeight: 36,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(246, 168, 168, 0.15)",
    paddingHorizontal: floraSpacing.grid,
  },
  unblockText: {
    color: "#f6a8a8",
    fontSize: 13,
    fontWeight: "300",
  },
}));
