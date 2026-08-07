import {
  apiGetE2EState,
  apiGetKeyBackup,
  apiGetRecoveryBackups,
  isApiRequestError,
} from "@flora/client-core/api";
import { ensureKeyBackupOnServer } from "@flora/client-core/fscp";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
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
import { settingsUi as ui } from "@/components/settings/settingsUi";
import { floraColors } from "@/lib/theme";
import { useFscpStore } from "@/stores/fscpStore";
import { useSessionStore } from "@/stores/sessionStore";

type Props = {
  visible: boolean;
  onClose: () => void;
};

const PH = "rgba(250, 250, 250, 0.3)";

function readBackupRevision(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const o = raw as Record<string, unknown>;
  const v = o.backupRevision ?? o.BackupRevision;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

export function SecurityFscpKeysModal({ visible, onClose }: Props) {
  const me = useSessionStore((s) => s.me);
  const fscpStatus = useFscpStore((s) => s.status);
  const material = useFscpStore((s) => s.material);
  const localPubKey = useFscpStore((s) => s.localPubKey);
  const serverPubKey = useFscpStore((s) => s.serverPubKey);
  const restoreWithAccountPassword = useFscpStore((s) => s.restoreWithAccountPassword);
  const publishLocalKeyConfirmed = useFscpStore((s) => s.publishLocalKeyConfirmed);
  const deleteLocalMaterial = useFscpStore((s) => s.deleteLocalMaterial);

  const [e2eState, setE2eState] = useState("");
  const [hasPasswordBackup, setHasPasswordBackup] = useState(false);
  const [backupRevision, setBackupRevision] = useState(0);
  const [recoveryCount, setRecoveryCount] = useState(0);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [state, backup, recoveries] = await Promise.all([
        apiGetE2EState(),
        apiGetKeyBackup().catch(() => null),
        apiGetRecoveryBackups().catch(() => []),
      ]);
      setE2eState(state.state);
      setHasPasswordBackup(backup != null);
      setBackupRevision(readBackupRevision(backup));
      setRecoveryCount(Array.isArray(recoveries) ? recoveries.length : 0);
    } catch {
      setE2eState("unknown");
      setHasPasswordBackup(false);
      setBackupRevision(0);
      setRecoveryCount(0);
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      setPassword("");
      setError(null);
      setSuccess(null);
      setBusy(false);
      return;
    }
    void load();
  }, [load, visible]);

  const onSyncRestore = async () => {
    if (!me?.userUuid || !password.trim()) {
      setError("Введите пароль аккаунта.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await restoreWithAccountPassword(me.userUuid, password);
      if (result.status === "ready") {
        setSuccess("Ключи синхронизированы с аккаунтом.");
        setPassword("");
        await load();
      } else {
        setError(`Синхронизация: ${result.status}`);
      }
    } catch (e) {
      setError(isApiRequestError(e) || e instanceof Error ? e.message : "Ошибка синхронизации.");
    } finally {
      setBusy(false);
    }
  };

  const onUploadBackup = async () => {
    if (!me?.userUuid || !material) {
      setError("Ключи FSCP ещё не готовы.");
      return;
    }
    if (!password.trim()) {
      setError("Введите пароль для шифрования резервной копии.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await ensureKeyBackupOnServer({
        ownerUserUuid: me.userUuid,
        accountPassword: password,
        material,
        authoritativeOverwrite: true,
      });
      if (result.uploaded) {
        setSuccess("Резервная копия по паролю загружена на сервер.");
        setPassword("");
        await load();
      } else if (result.skippedReason === "unchanged") {
        setSuccess("Резервная копия уже актуальна.");
        setPassword("");
      } else if (result.skippedReason === "conflict") {
        setError("Конфликт epoch identity на сервере. Войдите с паролем заново.");
      } else {
        setError(`Не удалось обновить backup (${result.skippedReason ?? "unknown"}).`);
      }
    } catch (e) {
      setError(
        isApiRequestError(e) || e instanceof Error
          ? e.message
          : "Не удалось загрузить резервную копию ключей.",
      );
    } finally {
      setBusy(false);
    }
  };

  const onPublish = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await publishLocalKeyConfirmed();
      setSuccess("Ключ опубликован на сервере.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось опубликовать ключ.");
    } finally {
      setBusy(false);
    }
  };

  const onClearLocal = () => {
    if (!me?.userUuid || busy) return;
    Alert.alert(
      "Удалить локальные ключи?",
      "История сообщений на этом устройстве перестанет расшифровываться до повторной настройки.",
      [
        { text: "Отмена", style: "cancel" },
        {
          text: "Удалить",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusy(true);
              setError(null);
              setSuccess(null);
              try {
                await deleteLocalMaterial();
                setSuccess("Локальные ключи удалены.");
                await load();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Не удалось удалить локальные ключи.");
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  const keysMatch =
    localPubKey && serverPubKey ? localPubKey.trim() === serverPubKey.trim() : null;
  const showPublish = fscpStatus === "orphan_local_profile" || fscpStatus === "key_mismatch";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? undefined : onClose}>
      <View style={ui.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : onClose} />
        <View style={ui.modalCard}>
          <View style={ui.modalHeader}>
            <Text style={ui.modalTitle}>Ключи сообщений FSCP</Text>
            <Pressable onPress={onClose} disabled={busy} style={({ pressed }) => pressed && ui.pressed}>
              <Ionicons name="close" size={22} color={floraColors.gray} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={ui.nestedForm}>
              <MetaRow label="E2E" value={e2eState || "—"} />
              <MetaRow label="Локально" value={fscpStatus} />
              <MetaRow label="Устройство" value={material?.deviceUuidFromServer ?? "—"} />
              <MetaRow
                label="Backup"
                value={
                  hasPasswordBackup
                    ? `пароль · рев. ${backupRevision} · фраза · ${recoveryCount}`
                    : `нет пароля · фраза · ${recoveryCount}`
                }
              />
              <MetaRow
                label="Ключи"
                value={keysMatch === null ? "—" : keysMatch ? "local = server" : "расходятся"}
              />
            </View>

            <Text style={ui.modalBody}>
              Синхронизируйте ключи с сервера паролем аккаунта или обновите backup с этого устройства.
            </Text>

            <TextInput
              style={ui.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Пароль аккаунта"
              secureTextEntry
              editable={!busy}
              placeholderTextColor={PH}
            />

            <View style={ui.formActionsRow}>
              <Pressable
                style={({ pressed }) => [ui.softPrimaryButton, pressed && ui.pressed]}
                onPress={() => void onSyncRestore()}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color={floraColors.greenLight} />
                ) : (
                  <Text style={ui.softPrimaryButtonText}>Синхронизировать</Text>
                )}
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  ui.textAction,
                  (!material || busy) && ui.textActionDisabled,
                  pressed && ui.pressed,
                ]}
                onPress={() => void onUploadBackup()}
                disabled={busy || !material}
              >
                <Text style={ui.textActionPrimary}>Обновить backup</Text>
              </Pressable>
            </View>

            {showPublish ? (
              <Pressable
                style={({ pressed }) => [ui.textAction, pressed && ui.pressed]}
                onPress={() => void onPublish()}
                disabled={busy}
              >
                <Text style={ui.textActionPrimary}>
                  {fscpStatus === "key_mismatch"
                    ? "Заменить ключ на сервере"
                    : "Опубликовать локальный ключ"}
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              style={({ pressed }) => [
                ui.textAction,
                (!me?.userUuid || busy) && ui.textActionDisabled,
                pressed && ui.pressed,
              ]}
              onPress={onClearLocal}
              disabled={busy || !me?.userUuid}
            >
              <Text style={ui.textActionDanger}>Удалить ключи с устройства</Text>
            </Pressable>

            {error ? <Text style={ui.feedbackError}>{error}</Text> : null}
            {success ? <Text style={ui.feedbackSuccess}>{success}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    gap: 15,
    paddingBottom: 4,
  },
  metaRow: {
    gap: 2,
  },
  metaLabel: {
    color: floraColors.gray,
    fontSize: 12,
    fontWeight: "300",
    letterSpacing: 0.3,
  },
  metaValue: {
    color: floraColors.whiteTemplate,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.3,
  },
});
