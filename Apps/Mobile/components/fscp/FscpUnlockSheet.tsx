import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { floraColors } from "@/lib/theme";
import { useFscpStore } from "@/stores/fscpStore";

type FscpUnlockSheetProps = {
  visible: boolean;
  userUuid: string | null;
  onClose: () => void;
};

/**
 * Inline-восстановление FSCP-ключей по паролю аккаунта (restore-only).
 * Мобайл всегда восстанавливает ИЗ backup и НЕ заливает (skipKeyBackupUpload=true внутри стора),
 * поэтому ввод пароля здесь никогда не перезаписывает серверный backup. Пароль не сохраняется.
 */
export function FscpUnlockSheet({ visible, userUuid, onClose }: FscpUnlockSheetProps) {
  const restoreWithAccountPassword = useFscpStore((s) => s.restoreWithAccountPassword);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setPassword("");
      setError(null);
      setBusy(false);
    }
  }, [visible]);

  const onSubmit = async () => {
    if (!userUuid) {
      setError("Нет активного пользователя.");
      return;
    }
    if (!password.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await restoreWithAccountPassword(userUuid, password);
      if (result.status === "ready") {
        setPassword("");
        onClose();
        return;
      }
      if (result.status === "wrong_password") {
        setError("Неверный пароль. Попробуйте ещё раз.");
      } else if (result.status === "backup_not_found") {
        setError(
          "Резервная копия не найдена. Войдите с паролем на вебе, чтобы создать backup, затем повторите.",
        );
      } else {
        setError(`Не удалось восстановить ключи (${result.status}).`);
      }
    } catch (e) {
      // Сетевая/серверная ошибка — это не «неверный пароль»: предложить повтор.
      setError(e instanceof Error ? e.message : "Сбой восстановления. Повторите попытку.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Закрыть" />
      <View style={styles.wrap} pointerEvents="box-none">
        <View style={styles.sheet}>
          <Text style={styles.title}>Восстановление ключей сообщений</Text>
          <Text style={styles.text}>
            На этом устройстве нет ключей шифрования. Введите пароль аккаунта один раз, чтобы
            восстановить доступ к зашифрованным сообщениям. Пароль не сохраняется.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Пароль аккаунта"
            placeholderTextColor={floraColors.textMuted}
            secureTextEntry
            autoFocus
            editable={!busy}
            value={password}
            onChangeText={(v) => {
              setPassword(v);
              if (error) setError(null);
            }}
            onSubmitEditing={() => void onSubmit()}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Pressable
              style={[styles.btn, styles.btnGhost]}
              onPress={onClose}
              disabled={busy}
            >
              <Text style={styles.btnGhostText}>Позже</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, styles.btnPrimary, (busy || !password.trim()) && styles.btnDisabled]}
              onPress={() => void onSubmit()}
              disabled={busy || !password.trim()}
            >
              {busy ? (
                <ActivityIndicator color="#10140f" />
              ) : (
                <Text style={styles.btnPrimaryText}>Восстановить</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(6, 10, 12, 0.62)",
  },
  wrap: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  sheet: {
    backgroundColor: floraColors.surfaceElevated,
    borderColor: floraColors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    gap: 14,
  },
  title: {
    color: floraColors.text,
    fontSize: 17,
    fontWeight: "600",
  },
  text: {
    color: floraColors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  input: {
    backgroundColor: floraColors.surface,
    borderColor: floraColors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: floraColors.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  error: {
    color: "#ff7a7a",
    fontSize: 13,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },
  btn: {
    height: 42,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  btnGhost: {
    borderColor: floraColors.border,
    borderWidth: 1,
  },
  btnGhostText: {
    color: floraColors.text,
    fontWeight: "600",
  },
  btnPrimary: {
    backgroundColor: floraColors.accent,
  },
  btnPrimaryText: {
    color: "#10140f",
    fontWeight: "700",
  },
  btnDisabled: {
    opacity: 0.5,
  },
});
