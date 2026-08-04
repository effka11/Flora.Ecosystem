import {
  apiCancelRegistration,
  apiLogin,
  apiPasswordResetComplete,
  apiPasswordResetStart,
  apiPasswordResetVerify,
  apiRegister,
  apiVerifyRegistration,
  saveLoginResponse,
} from "@flora/client-core/auth";
import { isTwoFactorChallenge } from "@flora/client-core/contracts";
import { isApiRequestError } from "@flora/client-core/api";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { AuthField } from "./AuthField";
import { AuthFooterLinks } from "./AuthFooterLinks";
import { AuthLogo } from "./AuthLogo";
import {
  AUTH_PANEL_ENTER_MS,
  AUTH_PANEL_EXIT_MS,
  AuthPanelAnim,
  AuthPanelTransition,
} from "./AuthPanelTransition";
import { AuthScreenLayout } from "./AuthScreenLayout";
import { AuthSubmitButton } from "./AuthSubmitButton";
import { authStyles } from "./styles";
import { mobileSessionStore } from "@/lib/session";
import { useSessionStore } from "@/stores/sessionStore";
import { useFscpStore } from "@/stores/fscpStore";

export type AuthFlowMode =
  | "login"
  | "register"
  | "verify"
  | "resetEmail"
  | "resetCode"
  | "resetPassword"
  | "resetSuccess";

const MODE_ORDER: Record<AuthFlowMode, number> = {
  login: 0,
  register: 1,
  verify: 2,
  resetEmail: 3,
  resetCode: 4,
  resetPassword: 5,
  resetSuccess: 6,
};

type AuthFlowProps = {
  initialMode?: AuthFlowMode;
};

export function AuthFlow({ initialMode = "login" }: AuthFlowProps) {
  const [mode, setMode] = useState<AuthFlowMode>(initialMode);
  const [modeAnim, setModeAnim] = useState<AuthPanelAnim>("none");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [awaitingTwoFactor, setAwaitingTwoFactor] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [completionToken, setCompletionToken] = useState("");
  const [devVerificationHint, setDevVerificationHint] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const activateLogin = useSessionStore((s) => s.activateLogin);
  const beginLogin = useSessionStore((s) => s.beginLogin);

  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitionTokenRef = useRef(0);

  const whiteTheme = mode === "verify" || mode === "resetCode";

  const clearTransitionTimers = () => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (enterTimerRef.current) {
      clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
  };

  useEffect(() => () => clearTransitionTimers(), []);

  const clearResetState = () => {
    setResetToken("");
    setCompletionToken("");
    setVerificationCode("");
    setDevVerificationHint(null);
    setPassword("");
    setConfirmPassword("");
  };

  const cancelVerification = async () => {
    if (verificationToken) {
      await apiCancelRegistration(verificationToken).catch(() => undefined);
    }
    setVerificationToken("");
    setVerificationCode("");
    setDevVerificationHint(null);
  };

  const switchMode = (nextMode: AuthFlowMode) => {
    if (nextMode === mode && modeAnim === "none") {
      return;
    }

    if (mode === "verify" && nextMode !== "verify") {
      void cancelVerification();
    }

    if (
      (mode === "resetEmail" ||
        mode === "resetCode" ||
        mode === "resetPassword" ||
        mode === "resetSuccess") &&
      nextMode !== "resetEmail" &&
      nextMode !== "resetCode" &&
      nextMode !== "resetPassword" &&
      nextMode !== "resetSuccess"
    ) {
      clearResetState();
    }

    if (mode === "login" && nextMode !== "login") {
      setAwaitingTwoFactor(false);
      setTwoFactorCode("");
    }

    clearTransitionTimers();

    const token = ++transitionTokenRef.current;
    const goLeft = MODE_ORDER[nextMode] > MODE_ORDER[mode];
    setModeAnim(goLeft ? "exitLeft" : "exitRight");

    exitTimerRef.current = setTimeout(() => {
      if (token !== transitionTokenRef.current) {
        return;
      }
      setMode(nextMode);
      setModeAnim(goLeft ? "enterLeft" : "enterRight");
      enterTimerRef.current = setTimeout(() => {
        if (token !== transitionTokenRef.current) {
          return;
        }
        setModeAnim("none");
      }, AUTH_PANEL_ENTER_MS);
    }, AUTH_PANEL_EXIT_MS);
  };

  const finishAuth = async (
    requiresProfileCompletion: boolean,
    loginPassword?: string,
    isRegistration = false,
  ) => {
    if (requiresProfileCompletion) {
      await mobileSessionStore.setPendingProfileSetup(true);
    }

    await activateLogin();

    const me = useSessionStore.getState().me;

    if (me?.userUuid) {
      if (loginPassword && isRegistration) {
        try {
          await useFscpStore.getState().provisionKeysAtRegistration(me.userUuid, loginPassword);
        } catch (syncErr) {
          if (__DEV__) {
            console.warn("[fscp] registration provision failed", syncErr);
          }
        }
      } else if (loginPassword) {
        try {
          await useFscpStore.getState().restoreWithAccountPassword(me.userUuid, loginPassword);
        } catch (syncErr) {
          if (__DEV__) {
            console.warn("[fscp] login sync failed", syncErr);
          }
        }
      } else {
        await useFscpStore.getState().bootstrap(me.userUuid);
      }
    }

    router.replace(requiresProfileCompletion ? "/(auth)/complete-profile" : "/(tabs)/feed");
  };

  const onSubmit = async () => {
    setError(null);

    if ((mode === "register" || mode === "resetPassword") && password !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }

    if ((mode === "verify" || mode === "resetCode") && !verificationCode.trim()) {
      setError("Введите код из сообщения");
      return;
    }

    if (mode === "verify" && !verificationToken) {
      setError("Сессия верификации истекла. Зарегистрируйтесь снова.");
      return;
    }

    if (mode === "resetCode" && !resetToken) {
      setError("Сессия сброса истекла. Начните снова.");
      return;
    }

    if (mode === "resetPassword" && !completionToken) {
      setError("Сессия сброса истекла. Начните снова.");
      return;
    }

    if (mode === "resetSuccess") {
      clearResetState();
      switchMode("login");
      return;
    }

    setLoading(true);
    try {
      if (mode === "login") {
        const result = await apiLogin(
          email.trim(),
          password,
          awaitingTwoFactor ? twoFactorCode.trim() : undefined,
        );
        if (isTwoFactorChallenge(result)) {
          setAwaitingTwoFactor(true);
          setError(result.error ?? "Введите код двухфакторной аутентификации (2FA).");
          return;
        }
        setAwaitingTwoFactor(false);
        setTwoFactorCode("");
        beginLogin();
        await saveLoginResponse(mobileSessionStore, result);
        await finishAuth(Boolean(result.requiresProfileCompletion), password);
        return;
      }

      if (mode === "register") {
        const res = await apiRegister(email.trim(), password);
        setVerificationToken(res.verificationToken);
        setVerificationCode(res.devVerificationCode ?? "");
        setDevVerificationHint(res.devVerificationCode ?? null);
        switchMode("verify");
        return;
      }

      if (mode === "resetEmail") {
        const started = await apiPasswordResetStart(email.trim());
        setResetToken(started.resetToken);
        setVerificationCode(started.devVerificationCode ?? "");
        setDevVerificationHint(started.devVerificationCode ?? null);
        setCompletionToken("");
        switchMode("resetCode");
        return;
      }

      if (mode === "resetCode") {
        const verified = await apiPasswordResetVerify({
          resetToken,
          code: verificationCode.trim(),
        });
        setCompletionToken(verified.completionToken);
        setPassword("");
        setConfirmPassword("");
        setDevVerificationHint(null);
        switchMode("resetPassword");
        return;
      }

      if (mode === "resetPassword") {
        await apiPasswordResetComplete({
          completionToken,
          newPassword: password,
        });
        clearResetState();
        switchMode("resetSuccess");
        return;
      }

      if (mode === "verify") {
        const res = await apiVerifyRegistration({
          verificationToken,
          code: verificationCode.trim(),
        });
        beginLogin();
        await saveLoginResponse(mobileSessionStore, res);
        await finishAuth(true, password, true);
      }
    } catch (e) {
      setError(
        isApiRequestError(e) ? e.message : e instanceof Error ? e.message : "Неизвестная ошибка",
      );
    } finally {
      setLoading(false);
    }
  };

  const goLogin = () => {
    setError(null);
    switchMode("login");
  };

  const goRegister = () => {
    setError(null);
    switchMode("register");
  };

  const goRegisterFromVerify = () => {
    setError(null);
    switchMode("register");
  };

  const goReset = () => {
    setError(null);
    switchMode("resetEmail");
  };

  const resendResetCode = async () => {
    setError(null);
    setLoading(true);
    try {
      const started = await apiPasswordResetStart(email.trim());
      setResetToken(started.resetToken);
      setVerificationCode(started.devVerificationCode ?? "");
      setDevVerificationHint(started.devVerificationCode ?? null);
    } catch (e) {
      setError(
        isApiRequestError(e) ? e.message : e instanceof Error ? e.message : "Неизвестная ошибка",
      );
    } finally {
      setLoading(false);
    }
  };

  const submitLabel =
    mode === "login"
      ? awaitingTwoFactor
        ? "Подтвердить"
        : "Войти"
      : mode === "register"
        ? "Создать аккаунт"
        : mode === "verify" || mode === "resetCode"
          ? "Подтвердить"
          : mode === "resetEmail"
            ? "Отправить"
            : mode === "resetPassword"
              ? "Сменить пароль"
              : mode === "resetSuccess"
                ? "Войти"
                : "Продолжить";

  return (
    <AuthScreenLayout loading={loading} error={error} onErrorDismiss={() => setError(null)}>
      <AuthPanelTransition anim={modeAnim}>
        <AuthLogo />

        <View style={authStyles.formStack}>
          {mode === "resetSuccess" ? (
            <Text style={authStyles.devHint}>
              Пароль изменён. Теперь можно войти с новым паролем.
            </Text>
          ) : null}

          {(mode === "login" ||
            mode === "register" ||
            mode === "resetEmail" ||
            mode === "resetPassword") && (
            <AuthField
              icon="mail"
              placeholder="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
              editable={mode !== "resetPassword"}
            />
          )}

          {(mode === "login" || mode === "register" || mode === "resetPassword") && (
            <AuthField
              icon="lock"
              placeholder={mode === "resetPassword" ? "Новый пароль" : "Пароль"}
              secureTextEntry={!showPassword}
              showPasswordToggle
              secureVisible={showPassword}
              onToggleSecure={() => setShowPassword((v) => !v)}
              textContentType={
                mode === "register" || mode === "resetPassword" ? "newPassword" : "password"
              }
              autoComplete={
                mode === "register" || mode === "resetPassword" ? "password-new" : "password"
              }
              value={password}
              onChangeText={setPassword}
            />
          )}

          {(mode === "verify" || mode === "resetCode") && (
            <>
              <AuthField icon="mail" placeholder="Email" editable={false} value={email} whiteTheme />
              <AuthField
                icon="lock"
                placeholder="Код из письма"
                autoCapitalize="none"
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                value={verificationCode}
                onChangeText={setVerificationCode}
                whiteTheme
              />
            </>
          )}

          {(mode === "register" || mode === "resetPassword") && (
            <AuthField
              icon="lock"
              placeholder="Подтверждение пароля"
              secureTextEntry
              textContentType="newPassword"
              autoComplete="password-new"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
            />
          )}

          {mode === "login" && awaitingTwoFactor ? (
            <AuthField
              icon="lock"
              placeholder="Код 2FA из приложения"
              autoCapitalize="none"
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              value={twoFactorCode}
              onChangeText={setTwoFactorCode}
            />
          ) : null}

          {devVerificationHint && (mode === "verify" || mode === "resetCode") ? (
            <Text style={authStyles.devHint}>
              Локальная разработка: код подтверждения{" "}
              <Text style={authStyles.devHintStrong}>{devVerificationHint}</Text> (SMTP не настроен).
            </Text>
          ) : null}

          <View style={authStyles.preSubmitSlot}>
            {mode === "login" ? (
              <Pressable
                style={authStyles.forgotPasswordPseudo}
                onPress={goReset}
                accessibilityRole="button"
                accessibilityLabel="Восстановить пароль"
                hitSlop={8}
              >
                <Text style={authStyles.forgotPasswordLink}>Забыли пароль?</Text>
              </Pressable>
            ) : null}
          </View>

          <AuthSubmitButton
            label={submitLabel}
            loading={loading}
            whiteTheme={whiteTheme}
            onPress={onSubmit}
          />
        </View>

        {mode === "login" ? (
          <AuthFooterLinks variant="login" onCreate={goRegister} />
        ) : mode === "register" ? (
          <AuthFooterLinks variant="register" onLogin={goLogin} />
        ) : mode === "verify" ? (
          <AuthFooterLinks variant="verify" onWrongEmail={goRegisterFromVerify} onLogin={goLogin} />
        ) : mode === "resetEmail" ? (
          <AuthFooterLinks variant="resetEmail" onLogin={goLogin} />
        ) : mode === "resetCode" ? (
          <AuthFooterLinks
            variant="resetCode"
            onResend={() => {
              void resendResetCode();
            }}
            onChangeEmail={() => {
              setError(null);
              switchMode("resetEmail");
            }}
          />
        ) : mode === "resetPassword" ? (
          <AuthFooterLinks
            variant="resetPassword"
            onRestart={() => {
              setError(null);
              switchMode("resetEmail");
            }}
          />
        ) : (
          <AuthFooterLinks variant="resetSuccess" onLogin={goLogin} />
        )}
      </AuthPanelTransition>
    </AuthScreenLayout>
  );
}
