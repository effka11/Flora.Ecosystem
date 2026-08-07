import { isApiRequestError } from "@flora/client-core/api";
import {
  apiBeginEmailChange,
  apiChangePassword,
  apiChangePhone,
  apiConfirmEmailChange,
  apiDeleteAccount,
  apiGetMe,
  apiGetSecurityStatus,
  apiGetSessions,
  apiRevokeOtherSessions,
  type SessionDto,
} from "@flora/client-core/auth";
import { useCallback, useEffect, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { Security2FAModal } from "@/components/settings/Security2FAModal";
import { SecurityFscpKeysModal } from "@/components/settings/SecurityFscpKeysModal";
import { SecurityRecoveryPhraseModal } from "@/components/settings/SecurityRecoveryPhraseModal";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import { floraColors, floraSpacing } from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function matchesSearch(query: string, ...haystacks: readonly (string | null | undefined)[]): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return haystacks.some((item) => (item ?? "").toLowerCase().includes(q));
}

function formatSessionDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSessionLocation(session: SessionDto): string {
  const parts = [session.city, session.countryCode].filter(Boolean);
  if (parts.length > 0) return parts.join(", ");
  return session.ipAddress || "Неизвестно";
}

function FieldLabel({ label, verified }: { label: string; verified?: boolean }) {
  const showStatus = verified !== undefined;
  return (
    <View style={ui.labelWithMeta}>
      <Text style={[ui.fieldLabel, { height: undefined, paddingBottom: 0, paddingLeft: 0 }]}>
        {label}
      </Text>
      {showStatus ? (
        verified ? (
          <Ionicons
            name="checkmark"
            size={16}
            color={floraColors.greenLight}
            style={{ transform: [{ translateY: -3 }] }}
            accessibilityLabel="Подтверждён"
          />
        ) : (
          <Text
            style={{
              color: "#f6a8a8",
              fontSize: 19,
              fontWeight: "300",
              lineHeight: 19,
              transform: [{ translateY: -2 }],
            }}
            accessibilityLabel="Не подтверждён"
          >
            ×
          </Text>
        )
      ) : null}
    </View>
  );
}

function ConfirmCheck({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [ui.confirmCheckRow, pressed && !disabled && ui.pressed]}
      onPress={() => onChange(!checked)}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
    >
      <View style={[ui.confirmCheckBox, checked && ui.confirmCheckBoxOn]}>
        {checked ? <Ionicons name="checkmark" size={14} color={floraColors.greenLight} /> : null}
      </View>
      <Text style={ui.confirmCheckLabel}>{label}</Text>
    </Pressable>
  );
}

type Props = {
  searchQuery: string;
};

export function SecuritySettingsTab({ searchQuery }: Props) {
  const me = useSessionStore((s) => s.me);
  const setMe = useSessionStore((s) => s.setMe);
  const logout = useSessionStore((s) => s.logout);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await apiGetMe());
    } catch {
      /* keep previous me */
    }
  }, [setMe]);

  const savedEmail = me?.email?.trim() ?? "";
  const savedPhone = me?.phone?.trim() ?? "";

  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);

  const [twoFaOpen, setTwoFaOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [fscpOpen, setFscpOpen] = useState(false);

  const [emailDraft, setEmailDraft] = useState(savedEmail);
  const [emailStep, setEmailStep] = useState<"form" | "confirm">("form");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailChangeToken, setEmailChangeToken] = useState("");
  const [emailConfirmCode, setEmailConfirmCode] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null);

  const [phoneDraft, setPhoneDraft] = useState(savedPhone);
  const [phonePassword, setPhonePassword] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSuccess, setPhoneSuccess] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const [deleteFormOpen, setDeleteFormOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadSecurityMeta = useCallback(async () => {
    try {
      const status = await apiGetSecurityStatus();
      setTwoFactorEnabled(status.twoFactorEnabled);
      setEmailVerified(status.emailVerified);
      setPhoneVerified(status.phoneVerified);
    } catch {
      setTwoFactorEnabled(false);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      setSessions(await apiGetSessions());
    } catch (e) {
      setSessions([]);
      setSessionsError(
        isApiRequestError(e) || e instanceof Error ? e.message : "Не удалось загрузить сессии.",
      );
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSecurityMeta();
    void loadSessions();
  }, [loadSecurityMeta, loadSessions]);

  useEffect(() => {
    setEmailDraft(savedEmail);
    setEmailStep("form");
    setEmailPassword("");
    setEmailChangeToken("");
    setEmailConfirmCode("");
    setEmailError(null);
  }, [savedEmail]);

  useEffect(() => {
    setPhoneDraft(savedPhone);
    setPhonePassword("");
    setPhoneError(null);
  }, [savedPhone]);

  const emailDirty = emailDraft.trim() !== savedEmail;
  const emailPending = emailDirty || emailStep === "confirm";
  const emailIconVerified = emailVerified && !emailPending;

  const phoneDirty = phoneDraft.trim() !== savedPhone;
  const phoneIconVerified = phoneVerified && !phoneDirty;

  const passwordPending = newPassword.length > 0;

  const loginVisible = matchesSearch(
    searchQuery,
    "email",
    "почта",
    "телефон",
    "пароль",
    "вход",
    "логин",
  );
  const protectionVisible = matchesSearch(
    searchQuery,
    "2fa",
    "двухфактор",
    "totp",
    "фраза",
    "recovery",
    "fscp",
    "ключ",
    "e2e",
    "шифрование",
  );
  const sessionsVisible = matchesSearch(
    searchQuery,
    "сесси",
    "устройство",
    "активн",
    "заверш",
  );
  const deleteVisible = matchesSearch(searchQuery, "удал", "аккаунт", "delete");

  if (
    normalizeSearch(searchQuery) &&
    !loginVisible &&
    !protectionVisible &&
    !sessionsVisible &&
    !deleteVisible
  ) {
    return null;
  }

  const otherSessionsCount = sessions.filter((s) => !s.isCurrent).length;

  const resetEmailExtras = () => {
    setEmailDraft(savedEmail);
    setEmailPassword("");
    setEmailChangeToken("");
    setEmailConfirmCode("");
    setEmailStep("form");
    setEmailError(null);
    setEmailSuccess(null);
  };

  const onEmailDraftChange = (value: string) => {
    setEmailDraft(value);
    setEmailError(null);
    setEmailSuccess(null);
    if (emailStep === "confirm") {
      setEmailStep("form");
      setEmailChangeToken("");
      setEmailConfirmCode("");
    }
  };

  const onBeginEmailChange = async () => {
    setEmailError(null);
    setEmailSuccess(null);
    if (!emailDraft.trim()) {
      setEmailError("Укажите новый email.");
      return;
    }
    if (!emailPassword.trim()) {
      setEmailError("Укажите пароль.");
      return;
    }
    setEmailBusy(true);
    try {
      const result = await apiBeginEmailChange(emailPassword, emailDraft.trim());
      setEmailChangeToken(result.changeToken);
      setEmailStep("confirm");
      const devHint = result.devVerificationCode
        ? ` Код для разработки: ${result.devVerificationCode}`
        : "";
      setEmailSuccess(`Код отправлен на ${emailDraft.trim()}.${devHint}`);
    } catch (e) {
      setEmailError(
        isApiRequestError(e) || e instanceof Error ? e.message : "Не удалось начать смену email.",
      );
    } finally {
      setEmailBusy(false);
    }
  };

  const onConfirmEmailChange = async () => {
    setEmailError(null);
    if (!emailConfirmCode.trim()) {
      setEmailError("Введите код из письма.");
      return;
    }
    setEmailBusy(true);
    try {
      await apiConfirmEmailChange(emailChangeToken, emailConfirmCode.trim());
      setEmailSuccess("Email обновлён.");
      setEmailPassword("");
      setEmailChangeToken("");
      setEmailConfirmCode("");
      setEmailStep("form");
      await refreshMe();
      await loadSecurityMeta();
    } catch (e) {
      setEmailError(
        isApiRequestError(e) || e instanceof Error
          ? e.message
          : "Не удалось подтвердить смену email.",
      );
    } finally {
      setEmailBusy(false);
    }
  };

  const resetPhoneExtras = () => {
    setPhoneDraft(savedPhone);
    setPhonePassword("");
    setPhoneError(null);
    setPhoneSuccess(null);
  };

  const onPhoneDraftChange = (value: string) => {
    setPhoneDraft(value);
    setPhoneError(null);
    setPhoneSuccess(null);
  };

  const onSubmitPhone = async () => {
    setPhoneError(null);
    setPhoneSuccess(null);
    if (!phoneDraft.trim()) {
      setPhoneError("Укажите номер телефона.");
      return;
    }
    if (!phonePassword.trim()) {
      setPhoneError("Укажите пароль.");
      return;
    }
    setPhoneBusy(true);
    try {
      await apiChangePhone(phonePassword, phoneDraft.trim());
      setPhoneSuccess("Номер обновлён. SMS-подтверждение будет добавлено позже.");
      setPhonePassword("");
      await refreshMe();
      await loadSecurityMeta();
    } catch (e) {
      setPhoneError(
        isApiRequestError(e) || e instanceof Error
          ? e.message
          : "Не удалось сменить номер телефона.",
      );
    } finally {
      setPhoneBusy(false);
    }
  };

  const resetPasswordExtras = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
    setPasswordSuccess(null);
  };

  const onNewPasswordChange = (value: string) => {
    setNewPassword(value);
    setPasswordError(null);
    setPasswordSuccess(null);
    if (!value) {
      setCurrentPassword("");
      setConfirmPassword("");
    }
  };

  const onSubmitPassword = async () => {
    setPasswordError(null);
    setPasswordSuccess(null);
    if (!currentPassword.trim()) {
      setPasswordError("Укажите текущий пароль.");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("Новый пароль должен быть не короче 8 символов.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Новый пароль и подтверждение не совпадают.");
      return;
    }
    setPasswordBusy(true);
    try {
      await apiChangePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordError(null);
      setPasswordSuccess("Пароль изменён.");
      await loadSessions();
    } catch (e) {
      setPasswordError(
        isApiRequestError(e) || e instanceof Error ? e.message : "Не удалось сменить пароль.",
      );
    } finally {
      setPasswordBusy(false);
    }
  };

  const onRevokeOthers = async () => {
    setSessionsError(null);
    setRevokingOthers(true);
    try {
      await apiRevokeOtherSessions();
      await loadSessions();
    } catch (e) {
      setSessionsError(
        isApiRequestError(e) || e instanceof Error
          ? e.message
          : "Не удалось завершить другие сессии.",
      );
    } finally {
      setRevokingOthers(false);
    }
  };

  const resetDeleteForm = () => {
    setDeletePassword("");
    setDeleteConfirm(false);
    setDeleteError(null);
  };

  const onToggleDeleteForm = () => {
    setDeleteFormOpen((open) => {
      if (open) resetDeleteForm();
      return !open;
    });
  };

  const onDeleteAccount = async () => {
    setDeleteError(null);
    if (!deletePassword.trim()) {
      setDeleteError("Введите пароль для подтверждения.");
      return;
    }
    if (!deleteConfirm) {
      setDeleteError("Подтвердите, что понимаете последствия удаления.");
      return;
    }
    setDeleteBusy(true);
    try {
      await apiDeleteAccount(deletePassword);
      await logout(true);
    } catch (e) {
      setDeleteError(
        isApiRequestError(e) || e instanceof Error ? e.message : "Не удалось удалить аккаунт.",
      );
      setDeleteBusy(false);
    }
  };

  const ph = "rgba(250, 250, 250, 0.3)";

  return (
    <View style={ui.tabBody}>
      {loginVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Данные для входа</Text>
          <View style={ui.fieldsStack}>
            <View style={ui.fieldGroup}>
              <FieldLabel label="Email" verified={emailIconVerified} />
              <TextInput
                style={ui.input}
                value={emailDraft}
                onChangeText={onEmailDraftChange}
                placeholder="Не указан"
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                editable={!emailBusy}
                placeholderTextColor={ph}
              />
              {emailPending ? (
                <View style={[ui.fieldsStack, { marginTop: floraSpacing.grid }]}>
                  {emailStep === "form" ? (
                    <>
                      <TextInput
                        style={ui.input}
                        value={emailPassword}
                        onChangeText={setEmailPassword}
                        placeholder="Текущий пароль"
                        secureTextEntry
                        editable={!emailBusy}
                        placeholderTextColor={ph}
                      />
                      <View style={ui.formActionsRow}>
                        <Pressable
                          style={({ pressed }) => [ui.softPrimaryButton, pressed && ui.pressed]}
                          onPress={() => void onBeginEmailChange()}
                          disabled={emailBusy}
                        >
                          {emailBusy ? (
                            <ActivityIndicator color={floraColors.greenLight} />
                          ) : (
                            <Text style={ui.softPrimaryButtonText}>Отправить код</Text>
                          )}
                        </Pressable>
                        <Pressable
                          style={({ pressed }) => [ui.softMutedButton, pressed && ui.pressed]}
                          onPress={resetEmailExtras}
                          disabled={emailBusy}
                        >
                          <Text style={ui.softMutedButtonText}>Отмена</Text>
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <>
                      <TextInput
                        style={ui.input}
                        value={emailConfirmCode}
                        onChangeText={(v) => setEmailConfirmCode(v.replace(/\D/g, "").slice(0, 6))}
                        placeholder="Код из письма"
                        keyboardType="number-pad"
                        editable={!emailBusy}
                        placeholderTextColor={ph}
                      />
                      <View style={ui.formActionsRow}>
                        <Pressable
                          style={({ pressed }) => [ui.softPrimaryButton, pressed && ui.pressed]}
                          onPress={() => void onConfirmEmailChange()}
                          disabled={emailBusy}
                        >
                          {emailBusy ? (
                            <ActivityIndicator color={floraColors.greenLight} />
                          ) : (
                            <Text style={ui.softPrimaryButtonText}>Подтвердить</Text>
                          )}
                        </Pressable>
                        <Pressable
                          style={({ pressed }) => [ui.softMutedButton, pressed && ui.pressed]}
                          onPress={() => {
                            setEmailStep("form");
                            setEmailConfirmCode("");
                            setEmailSuccess(null);
                          }}
                          disabled={emailBusy}
                        >
                          <Text style={ui.softMutedButtonText}>Назад</Text>
                        </Pressable>
                      </View>
                    </>
                  )}
                </View>
              ) : null}
              {emailError ? <Text style={ui.feedbackError}>{emailError}</Text> : null}
              {emailSuccess ? <Text style={ui.feedbackSuccess}>{emailSuccess}</Text> : null}
            </View>

            <View style={ui.fieldGroup}>
              <FieldLabel label="Номер телефона" verified={phoneIconVerified} />
              <TextInput
                style={ui.input}
                value={phoneDraft}
                onChangeText={onPhoneDraftChange}
                placeholder="Не указан"
                keyboardType="phone-pad"
                autoComplete="tel"
                editable={!phoneBusy}
                placeholderTextColor={ph}
              />
              {phoneDirty ? (
                <View style={[ui.fieldsStack, { marginTop: floraSpacing.grid }]}>
                  <TextInput
                    style={ui.input}
                    value={phonePassword}
                    onChangeText={setPhonePassword}
                    placeholder="Текущий пароль"
                    secureTextEntry
                    editable={!phoneBusy}
                    placeholderTextColor={ph}
                  />
                  <View style={ui.formActionsRow}>
                    <Pressable
                      style={({ pressed }) => [ui.softPrimaryButton, pressed && ui.pressed]}
                      onPress={() => void onSubmitPhone()}
                      disabled={phoneBusy}
                    >
                      {phoneBusy ? (
                        <ActivityIndicator color={floraColors.greenLight} />
                      ) : (
                        <Text style={ui.softPrimaryButtonText}>Сохранить</Text>
                      )}
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [ui.softMutedButton, pressed && ui.pressed]}
                      onPress={resetPhoneExtras}
                      disabled={phoneBusy}
                    >
                      <Text style={ui.softMutedButtonText}>Отмена</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              {phoneError ? <Text style={ui.feedbackError}>{phoneError}</Text> : null}
              {phoneSuccess ? <Text style={ui.feedbackSuccess}>{phoneSuccess}</Text> : null}
            </View>

            <View style={ui.fieldGroup}>
              <FieldLabel label="Пароль" />
              <TextInput
                style={ui.input}
                value={newPassword}
                onChangeText={onNewPasswordChange}
                placeholder="••••••••"
                secureTextEntry
                autoComplete="new-password"
                editable={!passwordBusy}
                placeholderTextColor={ph}
              />
              {passwordPending ? (
                <View style={[ui.fieldsStack, { marginTop: floraSpacing.grid }]}>
                  <TextInput
                    style={ui.input}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    placeholder="Подтверждение нового пароля"
                    secureTextEntry
                    editable={!passwordBusy}
                    placeholderTextColor={ph}
                  />
                  <TextInput
                    style={ui.input}
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                    placeholder="Текущий пароль"
                    secureTextEntry
                    editable={!passwordBusy}
                    placeholderTextColor={ph}
                  />
                  <View style={ui.formActionsRow}>
                    <Pressable
                      style={({ pressed }) => [ui.softPrimaryButton, pressed && ui.pressed]}
                      onPress={() => void onSubmitPassword()}
                      disabled={passwordBusy}
                    >
                      {passwordBusy ? (
                        <ActivityIndicator color={floraColors.greenLight} />
                      ) : (
                        <Text style={ui.softPrimaryButtonText}>Сохранить пароль</Text>
                      )}
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [ui.softMutedButton, pressed && ui.pressed]}
                      onPress={resetPasswordExtras}
                      disabled={passwordBusy}
                    >
                      <Text style={ui.softMutedButtonText}>Отмена</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              {passwordError ? <Text style={ui.feedbackError}>{passwordError}</Text> : null}
              {passwordSuccess ? <Text style={ui.feedbackSuccess}>{passwordSuccess}</Text> : null}
            </View>
          </View>
        </View>
      ) : null}

      {protectionVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Защита и шифрование</Text>
          <View style={ui.fieldsStack}>
            <View style={ui.listCard}>
              <View style={ui.listCardInfo}>
                <View style={ui.titleRow}>
                  <Text style={ui.listCardTitle}>Двухфакторная аутентификация</Text>
                  {twoFactorEnabled ? (
                    <View style={ui.outlineBadge}>
                      <Text style={ui.outlineBadgeText}>включена</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={ui.listCardDesc}>TOTP через приложение-аутентификатор</Text>
              </View>
              <Pressable
                style={({ pressed }) => [ui.textAction, pressed && ui.pressed]}
                onPress={() => setTwoFaOpen(true)}
              >
                <Text style={ui.textActionPrimary}>
                  {twoFactorEnabled ? "Управление" : "Включить"}
                </Text>
              </Pressable>
            </View>

            <View style={ui.listCard}>
              <View style={ui.listCardInfo}>
                <Text style={ui.listCardTitle}>Ключ-фраза</Text>
                <Text style={ui.listCardDesc}>
                  12 слов для восстановления доступа к зашифрованным данным
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [ui.textAction, pressed && ui.pressed]}
                onPress={() => setRecoveryOpen(true)}
              >
                <Text style={ui.textActionPrimary}>Настроить</Text>
              </Pressable>
            </View>

            <View style={ui.listCard}>
              <View style={ui.listCardInfo}>
                <Text style={ui.listCardTitle}>Ключ сообщений FSCP</Text>
                <Text style={ui.listCardDesc}>Сквозное шифрование переписок (E2EE)</Text>
              </View>
              <Pressable
                style={({ pressed }) => [ui.textAction, pressed && ui.pressed]}
                onPress={() => setFscpOpen(true)}
              >
                <Text style={ui.textActionPrimary}>Управление</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {sessionsVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Активные сессии</Text>
          {otherSessionsCount > 0 ? (
            <Pressable
              style={({ pressed }) => [
                ui.textAction,
                (revokingOthers || sessionsLoading) && ui.textActionDisabled,
                pressed && ui.pressed,
              ]}
              onPress={() => void onRevokeOthers()}
              disabled={revokingOthers || sessionsLoading}
            >
              {revokingOthers ? (
                <ActivityIndicator color="#f6a8a8" />
              ) : (
                <Text style={ui.textActionDanger}>Завершить все другие сессии</Text>
              )}
            </Pressable>
          ) : null}
          {sessionsError ? <Text style={ui.feedbackError}>{sessionsError}</Text> : null}
          {sessionsLoading ? <ActivityIndicator color={floraColors.greenLight} /> : null}
          {!sessionsLoading && sessions.length === 0 ? (
            <Text style={ui.sectionHint}>Активных сессий нет.</Text>
          ) : null}
          {!sessionsLoading && sessions.length > 0 ? (
            <View style={ui.fieldsStack}>
              {sessions.map((session) => (
                <View key={session.sessionId} style={ui.listCard}>
                  <View style={ui.listCardInfo}>
                    <View style={ui.titleRow}>
                      <Text style={ui.listCardTitle}>{formatSessionLocation(session)}</Text>
                      {session.isCurrent ? (
                        <View style={ui.outlineBadge}>
                          <Text style={ui.outlineBadgeText}>текущая</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={ui.listCardDesc}>
                      Активность · {formatSessionDate(session.lastActivity)}
                    </Text>
                    <Text style={ui.listCardDesc}>
                      Создана · {formatSessionDate(session.createdAt)}
                      {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {deleteVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Удаление аккаунта</Text>
          {!deleteFormOpen ? (
            <View style={ui.listCard}>
              <View style={ui.listCardInfo}>
                <Text style={ui.listCardTitle}>Безвозвратное удаление</Text>
                <Text style={ui.listCardDesc}>
                  Аккаунт, профиль и сессии будут удалены с сервера. Это действие нельзя отменить.
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [ui.textAction, pressed && ui.pressed]}
                onPress={onToggleDeleteForm}
              >
                <Text style={ui.textActionDanger}>Удалить</Text>
              </Pressable>
            </View>
          ) : (
            <View style={ui.nestedForm}>
              <Text style={ui.sectionHint}>
                Для подтверждения введите пароль и отметьте, что понимаете последствия.
              </Text>
              <TextInput
                style={ui.input}
                value={deletePassword}
                onChangeText={setDeletePassword}
                placeholder="Текущий пароль"
                secureTextEntry
                editable={!deleteBusy}
                placeholderTextColor={ph}
              />
              <ConfirmCheck
                checked={deleteConfirm}
                disabled={deleteBusy}
                onChange={setDeleteConfirm}
                label="Я понимаю, что аккаунт и данные будут удалены без возможности восстановления"
              />
              <View style={ui.formActionsRow}>
                <Pressable
                  style={({ pressed }) => [ui.dangerButton, pressed && ui.pressed]}
                  onPress={() => void onDeleteAccount()}
                  disabled={deleteBusy}
                >
                  {deleteBusy ? (
                    <ActivityIndicator color="#f6a8a8" />
                  ) : (
                    <Text style={ui.dangerButtonText}>Удалить навсегда</Text>
                  )}
                </Pressable>
                <Pressable
                  style={({ pressed }) => [ui.softMutedButton, pressed && ui.pressed]}
                  onPress={onToggleDeleteForm}
                  disabled={deleteBusy}
                >
                  <Text style={ui.softMutedButtonText}>Отмена</Text>
                </Pressable>
              </View>
              {deleteError ? <Text style={ui.feedbackError}>{deleteError}</Text> : null}
            </View>
          )}
        </View>
      ) : null}

      <Security2FAModal
        visible={twoFaOpen}
        enabled={twoFactorEnabled}
        onClose={() => setTwoFaOpen(false)}
        onChanged={() => void loadSecurityMeta()}
      />
      <SecurityRecoveryPhraseModal visible={recoveryOpen} onClose={() => setRecoveryOpen(false)} />
      <SecurityFscpKeysModal visible={fscpOpen} onClose={() => setFscpOpen(false)} />
    </View>
  );
}
