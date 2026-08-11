import {
  apiGetDismissedCommunities,
  apiGetHiddenFeedAuthors,
  apiUndismissCommunity,
  apiUnhideFeedAuthor,
} from "@flora/client-core/api";
import type { DismissedCommunityDto, HiddenFeedAuthorDto } from "@flora/client-core/contracts";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function SettingsFeedHiddenModal({ visible, onClose }: Props) {
  const [authors, setAuthors] = useState<HiddenFeedAuthorDto[]>([]);
  const [communities, setCommunities] = useState<DismissedCommunityDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, c] = await Promise.all([apiGetHiddenFeedAuthors(), apiGetDismissedCommunities()]);
      setAuthors(a);
      setCommunities(c);
    } catch (e) {
      setAuthors([]);
      setCommunities([]);
      setError(e instanceof Error ? e.message : "Не удалось загрузить список");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    void load();
  }, [load, visible]);

  const handleUnhideAuthor = async (userUuid: string) => {
    setBusyId(userUuid);
    setError(null);
    try {
      await apiUnhideFeedAuthor(userUuid);
      setAuthors((prev) => prev.filter((a) => a.userUuid !== userUuid));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось вернуть автора");
    } finally {
      setBusyId(null);
    }
  };

  const handleUndismissCommunity = async (communityId: string) => {
    setBusyId(communityId);
    setError(null);
    try {
      await apiUndismissCommunity(communityId);
      setCommunities((prev) => prev.filter((c) => c.communityId !== communityId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось вернуть сообщество");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.header}>
            <Text style={styles.title}>Скрытое в ленте</Text>
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
            Скрытые авторы и сообщества не попадают в рекомендации.
          </Text>

          {error ? <Text style={ui.feedbackError}>{error}</Text> : null}

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {loading ? (
              <ActivityIndicator color={floraColors.greenLight} style={styles.loader} />
            ) : (
              <>
                <Text style={styles.sectionLabel}>Авторы</Text>
                {authors.length === 0 ? (
                  <Text style={styles.empty}>Нет скрытых авторов.</Text>
                ) : (
                  authors.map((author) => {
                    const nick = author.username.replace(/^@+/, "");
                    const label = author.displayName || nick || "Пользователь";
                    const busy = busyId === author.userUuid;
                    return (
                      <View key={author.userUuid} style={styles.row}>
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
                          style={({ pressed }) => [styles.actionBtn, pressed && ui.pressed]}
                          onPress={() => void handleUnhideAuthor(author.userUuid)}
                          disabled={busy}
                        >
                          {busy ? (
                            <ActivityIndicator color={floraColors.greenLight} />
                          ) : (
                            <Text style={styles.actionText}>Вернуть</Text>
                          )}
                        </Pressable>
                      </View>
                    );
                  })
                )}

                <Text style={[styles.sectionLabel, styles.sectionLabelSpaced]}>Сообщества</Text>
                {communities.length === 0 ? (
                  <Text style={styles.empty}>Нет скрытых сообществ.</Text>
                ) : (
                  communities.map((community) => {
                    const busy = busyId === community.communityId;
                    return (
                      <View key={community.communityId} style={styles.row}>
                        <View style={styles.rowCopy}>
                          <Text style={styles.rowTitle} numberOfLines={1}>
                            {community.name || community.slug || "Сообщество"}
                          </Text>
                          {community.slug ? (
                            <Text style={styles.rowMeta} numberOfLines={1}>
                              /{community.slug}
                            </Text>
                          ) : null}
                        </View>
                        <Pressable
                          style={({ pressed }) => [styles.actionBtn, pressed && ui.pressed]}
                          onPress={() => void handleUndismissCommunity(community.communityId)}
                          disabled={busy}
                        >
                          {busy ? (
                            <ActivityIndicator color={floraColors.greenLight} />
                          ) : (
                            <Text style={styles.actionText}>Вернуть</Text>
                          )}
                        </Pressable>
                      </View>
                    );
                  })
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
    width: floraSpacing.grid * 2,
    height: floraSpacing.grid * 2,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    lineHeight: 20,
  },
  list: {
    maxHeight: 360,
  },
  loader: {
    marginVertical: floraSpacing.grid * 2,
  },
  sectionLabel: {
    color: floraColors.gray,
    fontSize: 12,
    fontWeight: "300",
    letterSpacing: 0.36,
    marginBottom: floraSpacing.gridFine,
  },
  sectionLabelSpaced: {
    marginTop: floraSpacing.grid,
  },
  empty: {
    color: "rgba(250, 250, 250, 0.35)",
    fontSize: 13,
    fontWeight: "300",
    marginBottom: floraSpacing.gridFine,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(250, 250, 250, 0.06)",
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
    fontSize: 12,
    fontWeight: "300",
  },
  actionBtn: {
    minHeight: floraSpacing.grid * 2 + floraSpacing.gridFine,
    paddingHorizontal: floraSpacing.grid,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(164, 209, 138, 0.12)",
  },
  actionText: {
    color: floraColors.greenLight,
    fontSize: 13,
    fontWeight: "300",
  },
});
