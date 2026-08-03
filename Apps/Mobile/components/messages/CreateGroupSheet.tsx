import {
  apiCreateGroup,
} from "@flora/client-core/api";
import type { MsgConversationDto, MsgGroupDetail } from "@flora/client-core/contracts";
import { filterMembersWithE2eKeys } from "@flora/client-core/fscp";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import {
  GROUP_CHAT_MAX_PEER_SELECTION,
  normalizeGroupTitleInput,
} from "@/lib/groupChatTypes";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  visible: boolean;
  conversations: readonly MsgConversationDto[];
  onClose: () => void;
  onCreated: (detail: MsgGroupDetail) => void;
};

/** Sheet создания FSCP-G группы (кандидаты — из DM-списка). */
export function CreateGroupSheet({ visible, conversations, onClose, onCreated }: Props) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setTitle("");
    setSelected(new Set());
    setQuery("");
    setError(null);
    setBusy(false);
  }, [visible]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = conversations.filter((c) => c.otherUserUuid);
    if (!q) return list;
    return list.filter((c) => {
      const name = (c.otherDisplayName || "").toLowerCase();
      const user = (c.otherUsername || "").toLowerCase();
      return name.includes(q) || user.includes(q);
    });
  }, [conversations, query]);

  const toggle = (uuid: string) => {
    if (busy) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else {
        if (next.size >= GROUP_CHAT_MAX_PEER_SELECTION) {
          setError(`Не больше ${GROUP_CHAT_MAX_PEER_SELECTION} участников кроме вас.`);
          return prev;
        }
        next.add(uuid);
      }
      return next;
    });
    setError(null);
  };

  const submit = () => {
    if (busy) return;
    const members = [...selected];
    if (members.length === 0) {
      setError("Выберите хотя бы одного участника.");
      return;
    }
    const titleNorm = normalizeGroupTitleInput(title);
    if (!titleNorm.ok) {
      setError(titleNorm.error);
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const { ok, missing } = await filterMembersWithE2eKeys(members);
        if (missing.length > 0) {
          Alert.alert(
            "Ключи шифрования",
            "У некоторых участников нет ключа шифрования. Пусть они один раз войдут в аккаунт.",
          );
          return;
        }
        if (ok.length === 0) {
          setError("Выберите хотя бы одного участника с ключом шифрования.");
          return;
        }
        const created = await apiCreateGroup({
          title: titleNorm.title,
          memberUserUuids: ok,
        });
        onCreated(created);
        onClose();
      } catch (e) {
        Alert.alert(
          "Группа",
          e instanceof Error ? e.message : "Не удалось создать группу.",
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={busy ? undefined : onClose}
    >
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
            onPress={onClose}
            disabled={busy}
            hitSlop={8}
          >
            <Text style={styles.ghost}>Закрыть</Text>
          </Pressable>
          <Text style={styles.title}>Новая группа</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Создать группу"
            onPress={submit}
            disabled={busy}
            hitSlop={8}
          >
            {busy ? (
              <ActivityIndicator color={floraColors.greenLight} />
            ) : (
              <Text style={styles.action}>Создать</Text>
            )}
          </Pressable>
        </View>

        <Text style={styles.label}>Название</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          maxLength={40}
          placeholder="Например, Команда"
          placeholderTextColor={floraColors.gray}
          editable={!busy}
          style={styles.input}
        />

        <Text style={styles.label}>Участники</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Поиск по имени или @username"
          placeholderTextColor={floraColors.gray}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy && conversations.length > 0}
          style={styles.input}
        />

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {conversations.length === 0 ? (
            <Text style={styles.empty}>
              Нет диалогов для выбора. Найдите человека во вкладке «Люди».
            </Text>
          ) : candidates.length === 0 ? (
            <Text style={styles.empty}>Никого не найдено.</Text>
          ) : (
            candidates.map((c) => {
              const checked = selected.has(c.otherUserUuid);
              const label = c.otherDisplayName || c.otherUsername;
              return (
                <Pressable
                  key={c.otherUserUuid}
                  accessibilityRole="button"
                  accessibilityState={{ selected: checked }}
                  disabled={busy}
                  style={({ pressed }) => [
                    styles.row,
                    checked && styles.rowActive,
                    pressed && styles.rowPressed,
                  ]}
                  onPress={() => toggle(c.otherUserUuid)}
                >
                  <FloraAvatar
                    size={40}
                    displayName={label}
                    username={c.otherUsername}
                    avatarUuid={c.otherAvatarUuid}
                    seed={c.otherUserUuid}
                  />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {label}
                    </Text>
                    <Text style={styles.rowHandle} numberOfLines={1}>
                      @{c.otherUsername.replace(/^@+/, "")}
                    </Text>
                  </View>
                  {checked ? (
                    <Ionicons name="checkmark-circle" size={22} color={floraColors.greenLight} />
                  ) : null}
                </Pressable>
              );
            })
          )}
        </ScrollView>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
    paddingHorizontal: floraSpacing.grid * 2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: floraSpacing.grid,
    minHeight: 40,
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 17,
    fontWeight: "300",
    letterSpacing: 0.5,
  },
  ghost: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
  },
  action: {
    color: floraColors.greenLight,
    fontSize: 15,
    fontWeight: "300",
  },
  label: {
    color: floraColors.gray,
    fontSize: 13,
    marginBottom: floraSpacing.gridFine,
    marginTop: floraSpacing.gridFine,
  },
  input: {
    borderWidth: 1,
    borderColor: "rgba(250,250,250,0.1)",
    borderRadius: 10,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    marginBottom: floraSpacing.grid,
  },
  list: { flex: 1 },
  empty: {
    color: floraColors.gray,
    fontSize: 14,
    textAlign: "center",
    marginTop: floraSpacing.grid * 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 1.5,
    paddingHorizontal: floraSpacing.gridFine,
    borderRadius: 10,
  },
  rowActive: { backgroundColor: "rgba(164, 209, 138, 0.1)" },
  rowPressed: { opacity: 0.85 },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowName: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
  },
  rowHandle: {
    color: floraColors.gray,
    fontSize: 13,
  },
  error: {
    color: "#f6a8a8",
    fontSize: 13,
    marginTop: floraSpacing.gridFine,
  },
});
