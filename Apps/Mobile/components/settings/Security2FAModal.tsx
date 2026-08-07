import { isApiRequestError } from "@flora/client-core/api";
import {
  apiBeginTwoFactorSetup,
  apiDisableTwoFactor,
  apiEnableTwoFactor,
} from "@flora/client-core/auth";
import { Ionicons } from "@expo/vector-icons";
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
import { settingsUi as ui } from "@/components/settings/settingsUi";
import { copyTextToClipboard } from "@/lib/copyToClipboard";
import { floraColors } from "@/lib/theme";

type Props = {
  visible: boolean;
  enabled: boolean;
  onClose: () => void;
  onChanged: () => void;
};

const PH = "rgba(250, 250, 250, 0.3)";

export function Security2FAModal({ visible, enabled, onClose, onChanged }: Props) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [step, setStep] = useState<"idle" | "setup" | "confirm">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setPassword("");
      setCode("");
      setSecret("");
      setStep("idle");
      setError(null);
      setSuccess(null);
      setBusy(false);
    } else if (enabled) {
      setStep("idle");
    }
  }, [enabled, visible]);

  const beginSetup = async () => {
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const result = await apiBeginTwoFactorSetup(password);
      setSecret(result.secret);
      setStep("confirm");
    } catch (e) {
      setError(isApiRequestError(e) ? e.message : "Не удалось начать настройку 2FA.");
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setError(null);
    setBusy(true);
    try {
      await apiEnableTwoFactor(code);
      setSuccess("2FA включена.");
      onChanged();
      setTimeout(onClose, 600);
    } catch (e) {
      setError(isApiRequestError(e) ? e.message : "Не удалось включить 2FA.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setError(null);
    setBusy(true);
    try {
      await apiDisableTwoFactor(password, code);
      setSuccess("2FA отключена.");
      onChanged();
      setTimeout(onClose, 600);
    } catch (e) {
      setError(isApiRequestError(e) ? e.message : "Не удалось отключить 2FA.");
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
            <Text style={ui.modalTitle}>Двухфакторная аутентификация</Text>
            <Pressable onPress={onClose} disabled={busy} style={({ pressed }) => pressed && ui.pressed}>
              <Ionicons name="close" size={22} color={floraColors.gray} />
            </Pressable>
          </View>

          {enabled ? (
            <>
              <Text style={ui.modalBody}>
                Введите пароль и код из приложения-аутентификатора, чтобы отключить 2FA.
              </Text>
              <TextInput
                style={ui.input}
                value={password}
                onChangeText={setPassword}
                placeholder="Пароль"
                secureTextEntry
                editable={!busy}
                placeholderTextColor={PH}
              />
              <TextInput
                style={ui.input}
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
                placeholder="Код 2FA"
                keyboardType="number-pad"
                editable={!busy}
                placeholderTextColor={PH}
              />
              <Pressable
                style={({ pressed }) => [ui.dangerButton, pressed && ui.pressed]}
                onPress={() => void disable()}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color="#f6a8a8" />
                ) : (
                  <Text style={ui.dangerButtonText}>Отключить</Text>
                )}
              </Pressable>
            </>
          ) : step === "confirm" ? (
            <>
              <Text style={ui.modalBody}>
                Добавьте секрет в аутентификатор и введите код подтверждения.
              </Text>
              <Pressable
                style={({ pressed }) => [ui.monoBlock, pressed && ui.pressed]}
                onPress={() => void copyTextToClipboard(secret)}
              >
                <Text style={[ui.monoText, { letterSpacing: 1.2 }]}>{secret}</Text>
                <Text style={ui.monoHint}>Нажмите, чтобы скопировать</Text>
              </Pressable>
              <TextInput
                style={ui.input}
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
                placeholder="Код из приложения"
                keyboardType="number-pad"
                editable={!busy}
                placeholderTextColor={PH}
              />
              <View style={ui.formActionsRow}>
                <Pressable
                  style={({ pressed }) => [ui.softPrimaryButton, pressed && ui.pressed]}
                  onPress={() => void enable()}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color={floraColors.greenLight} />
                  ) : (
                    <Text style={ui.softPrimaryButtonText}>Включить</Text>
                  )}
                </Pressable>
                <Pressable
                  style={({ pressed }) => [ui.textAction, pressed && ui.pressed]}
                  onPress={() => setStep("setup")}
                  disabled={busy}
                >
                  <Text style={ui.textActionMuted}>Назад</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={ui.modalBody}>
                TOTP через приложение-аутентификатор. Введите пароль аккаунта.
              </Text>
              <TextInput
                style={ui.input}
                value={password}
                onChangeText={setPassword}
                placeholder="Пароль"
                secureTextEntry
                editable={!busy}
                placeholderTextColor={PH}
              />
              <Pressable
                style={({ pressed }) => [ui.softPrimaryButton, pressed && ui.pressed]}
                onPress={() => void beginSetup()}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color={floraColors.greenLight} />
                ) : (
                  <Text style={ui.softPrimaryButtonText}>Продолжить</Text>
                )}
              </Pressable>
            </>
          )}

          {error ? <Text style={ui.feedbackError}>{error}</Text> : null}
          {success ? <Text style={ui.feedbackSuccess}>{success}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}
