import { apiGetRecoveryBackups, apiPutRecoveryBackup, isApiRequestError } from "@flora/client-core/api";
import {
  bootstrapPlaintextFromLocalMaterial,
  createRecoveryBackup,
  generateRecoveryPhrase,
  RECOVERY_WORDLIST_ID,
} from "@flora/client-core/fscp";
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
import { copyTextToClipboard } from "@/lib/copyToClipboard";
import { floraNewUuid } from "@/lib/floraUuid";
import { floraColors } from "@/lib/theme";
import { useFscpStore } from "@/stores/fscpStore";
import { useSessionStore } from "@/stores/sessionStore";

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function SecurityRecoveryPhraseModal({ visible, onClose }: Props) {
  const me = useSessionStore((s) => s.me);
  const material = useFscpStore((s) => s.material);
  const [existingCount, setExistingCount] = useState(0);
  const [phrase, setPhrase] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhrase("");
    setConfirmed(false);
    setError(null);
    setSuccess(null);
    setBusy(false);
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      const raw = await apiGetRecoveryBackups();
      setExistingCount(Array.isArray(raw) ? raw.length : 0);
    } catch {
      setExistingCount(0);
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      reset();
      return;
    }
    void loadMeta();
  }, [loadMeta, reset, visible]);

  const onGenerate = () => {
    setError(null);
    setSuccess(null);
    setConfirmed(false);
    setPhrase(generateRecoveryPhrase());
  };

  const onSave = async () => {
    if (!me?.userUuid || !material) {
      setError("Ключи FSCP ещё не готовы. Откройте сообщения и повторите попытку.");
      return;
    }
    if (!phrase) {
      setError("Сначала сгенерируйте ключ-фразу.");
      return;
    }
    if (!confirmed) {
      setError("Подтвердите, что вы сохранили фразу в надёжном месте.");
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const plaintext = await bootstrapPlaintextFromLocalMaterial(
        material.agreementPrivateKey,
        material.signingPrivateKey,
      );
      const payload = await createRecoveryBackup({
        userUuid: me.userUuid,
        recoveryPhrase: phrase,
        plaintext,
        recoveryRevision: existingCount + 1,
        epochSetRevision: 1,
        recoveryKeyId: floraNewUuid(),
        wordlistId: RECOVERY_WORDLIST_ID,
      });
      await apiPutRecoveryBackup(payload as unknown as Record<string, unknown>);
      setSuccess("Ключ-фраза сохранена на сервере в зашифрованном виде.");
      await loadMeta();
      setPhrase("");
      setConfirmed(false);
    } catch (e) {
      setError(
        isApiRequestError(e) || e instanceof Error
          ? e.message
          : "Не удалось сохранить резервную копию с ключ-фразой.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? undefined : onClose}>
      <View style={ui.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : onClose} />
        <View style={ui.modalCard}>
          <View style={ui.modalHeader}>
            <Text style={ui.modalTitle}>Ключ-фраза</Text>
            <Pressable onPress={onClose} disabled={busy} style={({ pressed }) => pressed && ui.pressed}>
              <Ionicons name="close" size={22} color={floraColors.gray} />
            </Pressable>
          </View>

          <Text style={ui.modalBody}>
            12 слов для восстановления доступа к зашифрованным данным. Запишите фразу в безопасном месте.
          </Text>
          {existingCount > 0 ? (
            <Text style={ui.sectionHint}>На сервере уже есть записей: {existingCount}</Text>
          ) : null}

          {phrase ? (
            <Pressable
              style={({ pressed }) => [ui.monoBlock, styles.phraseBox, pressed && ui.pressed]}
              onPress={() => void copyTextToClipboard(phrase)}
            >
              <ScrollView style={styles.phraseScroll} nestedScrollEnabled>
                <Text style={ui.monoText}>{phrase}</Text>
              </ScrollView>
              <Text style={ui.monoHint}>Нажмите, чтобы скопировать</Text>
            </Pressable>
          ) : null}

          <Pressable
            style={({ pressed }) => [ui.textAction, pressed && ui.pressed]}
            onPress={onGenerate}
            disabled={busy}
          >
            <Text style={ui.textActionPrimary}>
              {phrase ? "Сгенерировать заново" : "Сгенерировать фразу"}
            </Text>
          </Pressable>

          {phrase ? (
            <Pressable
              style={({ pressed }) => [ui.confirmCheckRow, pressed && !busy && ui.pressed]}
              onPress={() => setConfirmed((v) => !v)}
              disabled={busy}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: confirmed }}
            >
              <View style={[ui.confirmCheckBox, confirmed && ui.confirmCheckBoxOn]}>
                {confirmed ? (
                  <Ionicons name="checkmark" size={14} color={floraColors.greenLight} />
                ) : null}
              </View>
              <Text style={ui.confirmCheckLabel}>Я сохранил(а) фразу в надёжном месте</Text>
            </Pressable>
          ) : null}

          {phrase ? (
            <Pressable
              style={({ pressed }) => [ui.softPrimaryButton, pressed && ui.pressed]}
              onPress={() => void onSave()}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={floraColors.greenLight} />
              ) : (
                <Text style={ui.softPrimaryButtonText}>Сохранить на сервер</Text>
              )}
            </Pressable>
          ) : null}

          {error ? <Text style={ui.feedbackError}>{error}</Text> : null}
          {success ? <Text style={ui.feedbackSuccess}>{success}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  phraseBox: {
    maxHeight: 150,
  },
  phraseScroll: {
    maxHeight: 110,
  },
});
