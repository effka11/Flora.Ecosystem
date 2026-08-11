import type { MsgConversationDto } from "@flora/client-core/contracts";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
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
  formatGroupMembersLabel,
  GROUP_CHAT_MAX_MEMBERS,
  normalizeGroupTitlePatch,
  type GroupMember,
} from "@/lib/groupChatTypes";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  open: boolean;
  title: string;
  members: readonly GroupMember[];
  meUserUuid: string;
  isCreator: boolean;
  addCandidates: readonly MsgConversationDto[];
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSaveTitle?: (title: string) => Promise<boolean>;
  onRemoveMember?: (userUuid: string) => Promise<boolean>;
  onAddMember?: (userUuid: string) => Promise<boolean>;
};

export function GroupMembersSheet({
  open,
  title,
  members,
  meUserUuid,
  isCreator,
  addCandidates,
  busy = false,
  error = null,
  onClose,
  onSaveTitle,
  onRemoveMember,
  onAddMember,
}: Props) {
  const insets = useSafeAreaInsets();
  const [draftTitle, setDraftTitle] = useState(title);
  const [addQuery, setAddQuery] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    Keyboard.dismiss();
    setDraftTitle(title);
    setAddQuery("");
    setLocalError(null);
  }, [open, title]);

  const meNorm = meUserUuid.trim().toLowerCase();
  const memberSet = useMemo(
    () => new Set(members.map((m) => m.userUuid.trim().toLowerCase()).filter(Boolean)),
    [members],
  );

  const filteredAdd = useMemo(() => {
    if (!isCreator) return [];
    const q = addQuery.trim().toLowerCase();
    return addCandidates.filter((c) => {
      const uuid = c.otherUserUuid.trim().toLowerCase();
      if (!uuid || memberSet.has(uuid)) return false;
      if (!q) return true;
      const display = (c.otherDisplayName || "").toLowerCase();
      const user = (c.otherUsername || "").toLowerCase();
      return display.includes(q) || user.includes(q);
    });
  }, [addCandidates, addQuery, isCreator, memberSet]);

  const titleDirty = draftTitle.trim() !== title.trim();
  const atCapacity = members.length >= GROUP_CHAT_MAX_MEMBERS;
  const displayError = localError || error;

  const saveTitle = () => {
    if (!isCreator || !onSaveTitle || busy) return;
    const norm = normalizeGroupTitlePatch(draftTitle);
    if (!norm.ok) {
      setLocalError(norm.error);
      return;
    }
    setLocalError(null);
    void (async () => {
      const ok = await onSaveTitle(norm.title);
      if (!ok) setLocalError("Не удалось сохранить название.");
    })();
  };

  return (
    <Modal
      visible={open}
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
            onPress={onClose}
            disabled={busy}
            hitSlop={8}
          >
            <Text style={styles.ghost}>Закрыть</Text>
          </Pressable>
          <Text style={styles.title}>{formatGroupMembersLabel(members.length)}</Text>
          {isCreator && titleDirty ? (
            <Pressable accessibilityRole="button" onPress={saveTitle} disabled={busy} hitSlop={8}>
              {busy ? (
                <ActivityIndicator color={floraColors.greenLight} />
              ) : (
                <Text style={styles.action}>Сохранить</Text>
              )}
            </Pressable>
          ) : (
            <View style={styles.headerSpacer} />
          )}
        </View>

        {isCreator ? (
          <>
            <Text style={styles.label}>Название</Text>
            <TextInput
              value={draftTitle}
              onChangeText={(v) => {
                setDraftTitle(v);
                setLocalError(null);
              }}
              maxLength={40}
              editable={!busy}
              style={styles.input}
            />
          </>
        ) : (
          <Text style={styles.readonlyTitle} numberOfLines={1}>
            {title}
          </Text>
        )}

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {members.map((member) => {
            const label = member.displayName || member.username;
            const isMe = member.userUuid.trim().toLowerCase() === meNorm;
            const canKick = isCreator && !isMe && Boolean(onRemoveMember);
            return (
              <View key={member.userUuid} style={styles.row}>
                <FloraAvatar
                  size={40}
                  displayName={label}
                  username={member.username}
                  avatarUuid={member.avatarUuid}
                  seed={member.userUuid}
                />
                <View style={styles.rowBody}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {label}
                    {isMe ? " (вы)" : ""}
                  </Text>
                  <Text style={styles.rowHandle} numberOfLines={1}>
                    @{member.username.replace(/^@+/, "") || "…"}
                  </Text>
                </View>
                {canKick ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Удалить ${label}`}
                    disabled={busy}
                    onPress={() => {
                      setLocalError(null);
                      void (async () => {
                        const ok = await onRemoveMember!(member.userUuid);
                        if (!ok) setLocalError("Не удалось удалить участника.");
                      })();
                    }}
                  >
                    <Text style={styles.kick}>Удалить</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}

          {isCreator && onAddMember ? (
            <>
              <Text style={styles.label}>Добавить участника</Text>
              <TextInput
                value={addQuery}
                onChangeText={setAddQuery}
                placeholder={atCapacity ? "Группа заполнена" : "Поиск по имени или @username"}
                placeholderTextColor={floraColors.gray}
                editable={!busy && !atCapacity && addCandidates.length > 0}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              {!atCapacity
                ? filteredAdd.slice(0, 24).map((c) => {
                    const label = c.otherDisplayName || c.otherUsername;
                    return (
                      <Pressable
                        key={c.otherUserUuid}
                        accessibilityRole="button"
                        disabled={busy}
                        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                        onPress={() => {
                          setLocalError(null);
                          void (async () => {
                            const ok = await onAddMember(c.otherUserUuid);
                            if (!ok) setLocalError("Не удалось добавить участника.");
                          })();
                        }}
                      >
                        <FloraAvatar
                          size={40}
                          displayName={label}
                          username={c.otherUsername}
                          avatarUuid={c.otherAvatarUuid}
                          seed={c.otherUserUuid}
                        />
                        <View style={styles.rowBody}>
                          <Text style={styles.rowName}>{label}</Text>
                          <Text style={styles.rowHandle}>
                            @{c.otherUsername.replace(/^@+/, "")}
                          </Text>
                        </View>
                        <Ionicons name="add-circle-outline" size={22} color={floraColors.greenLight} />
                      </Pressable>
                    );
                  })
                : null}
            </>
          ) : null}
        </ScrollView>

        {displayError ? <Text style={styles.error}>{displayError}</Text> : null}
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
  headerSpacer: { width: 64 },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 17,
    fontWeight: "300",
  },
  ghost: { color: floraColors.gray, fontSize: 15, fontWeight: "300" },
  action: { color: floraColors.greenLight, fontSize: 15, fontWeight: "300" },
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
  readonlyTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 16,
    marginBottom: floraSpacing.grid,
  },
  list: { flex: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 1.5,
  },
  rowPressed: { opacity: 0.85 },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { color: floraColors.whiteTemplate, fontSize: 15, fontWeight: "300" },
  rowHandle: { color: floraColors.gray, fontSize: 13 },
  kick: { color: "#f6a8a8", fontSize: 13 },
  error: { color: "#f6a8a8", fontSize: 13, marginTop: floraSpacing.gridFine },
});
