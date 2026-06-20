import { isApiRequestError } from "@flora/client-core/api";
import { apiDeleteAvatar, apiGetMe } from "@flora/client-core/auth";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { FloraAvatar } from "@/components/FloraAvatar";
import { avatarUploadErrorMessage, uploadAvatarFromPickerAsset } from "@/lib/avatarUpload";
import { useSessionStore } from "@/stores/sessionStore";
import { floraColors, floraProfile, floraSpacing } from "@/lib/theme";

type ProfileAvatarEditorModalProps = {
  visible: boolean;
  onClose: () => void;
  displayName: string;
  username: string;
  userUuid?: string;
  avatarUuid?: string | null;
  cacheVersion?: number;
  onAvatarChanged?: () => void;
};

export function ProfileAvatarEditorModal({
  visible,
  onClose,
  displayName,
  username,
  userUuid,
  avatarUuid,
  cacheVersion = 0,
  onAvatarChanged,
}: ProfileAvatarEditorModalProps) {
  const setMe = useSessionStore((s) => s.setMe);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localCacheVersion, setLocalCacheVersion] = useState(0);

  const pickAvatar = async () => {
    setError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Нужен доступ к галерее для выбора фото.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    setBusy(true);
    try {
      await uploadAvatarFromPickerAsset(asset);
      const updated = await apiGetMe();
      setMe(updated);
      setLocalCacheVersion((v) => v + 1);
      onAvatarChanged?.();
    } catch (e) {
      setError(avatarUploadErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteAvatar = async () => {
    if (!avatarUuid) return;
    setError(null);
    setBusy(true);
    try {
      await apiDeleteAvatar();
      const updated = await apiGetMe();
      setMe(updated);
      setLocalCacheVersion((v) => v + 1);
      onAvatarChanged?.();
    } catch (e) {
      setError(isApiRequestError(e) ? e.message : "Не удалось удалить аватар.");
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    if (busy) return;
    setError(null);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <Pressable style={styles.dialog} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title}>Аватар</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
              hitSlop={10}
              onPress={handleClose}
              disabled={busy}
            >
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>

          <View style={styles.body}>
            <FloraAvatar
              size={floraProfile.avatarSize + floraSpacing.grid * 4}
              avatarUuid={avatarUuid}
              displayName={displayName}
              username={username}
              seed={userUuid ?? username}
              cacheVersion={cacheVersion + localCacheVersion}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.actions}>
              <Pressable
                style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                onPress={() => void pickAvatar()}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color={floraColors.text} />
                ) : (
                  <Text style={styles.buttonText}>Выбрать фото</Text>
                )}
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.button, styles.buttonGhost, pressed && styles.buttonPressed]}
                onPress={() => {
                  Alert.alert("Удалить аватар?", "Вернётся базовый аватар с буквами.", [
                    { text: "Отмена", style: "cancel" },
                    { text: "Удалить", style: "destructive", onPress: () => void deleteAvatar() },
                  ]);
                }}
                disabled={busy || !avatarUuid}
              >
                <Text style={styles.buttonText}>Удалить</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.65)",
    alignItems: "center",
    justifyContent: "center",
    padding: floraSpacing.grid * 2,
  },
  dialog: {
    width: "100%",
    maxWidth: 360,
    borderRadius: floraSpacing.grid,
    backgroundColor: floraColors.surface,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.12)",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid,
    borderBottomWidth: 1,
    borderBottomColor: floraProfile.statusStripe,
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 18,
    fontWeight: "300",
  },
  close: {
    color: floraColors.gray,
    fontSize: 28,
    lineHeight: 28,
  },
  body: {
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid * 2,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: floraSpacing.gridFine * 2,
  },
  button: {
    backgroundColor: floraColors.accentDark,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    minWidth: 120,
  },
  buttonGhost: {
    backgroundColor: floraColors.surface,
    borderColor: floraColors.border,
    borderWidth: 1,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: floraColors.text,
    fontWeight: "600",
  },
  error: {
    color: floraColors.error,
    fontSize: 14,
    textAlign: "center",
  },
});
