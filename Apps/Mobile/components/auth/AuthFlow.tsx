import {

  apiCancelRegistration,

  apiLogin,

  apiRegister,

  apiVerifyRegistration,

  saveLoginResponse,

} from "@flora/client-core/auth";

import { isTwoFactorChallenge } from "@flora/client-core/contracts";

import { isApiRequestError } from "@flora/client-core/api";

import { router } from "expo-router";

import { useEffect, useRef, useState } from "react";

import { Text, View } from "react-native";

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



export type AuthFlowMode = "login" | "register" | "verify";



const MODE_ORDER: Record<AuthFlowMode, number> = {

  login: 0,

  register: 1,

  verify: 2,

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

  const [devVerificationHint, setDevVerificationHint] = useState<string | null>(null);

  const [showPassword, setShowPassword] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);

  const bootstrap = useSessionStore((s) => s.bootstrap);



  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const transitionTokenRef = useRef(0);



  const whiteTheme = mode === "verify";



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

    await bootstrap();

    const me = useSessionStore.getState().me;

    if (me?.userUuid) {
      if (loginPassword && isRegistration) {
        // First device: create + publish identity AND upload the initial backup.
        try {
          await useFscpStore.getState().provisionKeysAtRegistration(me.userUuid, loginPassword);
        } catch (syncErr) {
          if (__DEV__) {
            console.warn("[fscp] registration provision failed", syncErr);
          }
        }
      } else if (loginPassword) {
        // Login: mobile is restore-only (web is the backup keeper).
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



    if (mode === "register" && password !== confirmPassword) {

      setError("Пароли не совпадают");

      return;

    }

    if (mode === "verify" && !verificationCode.trim()) {

      setError("Введите код из сообщения");

      return;

    }

    if (mode === "verify" && !verificationToken) {

      setError("Сессия верификации истекла. Зарегистрируйтесь снова.");

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



      const res = await apiVerifyRegistration({

        verificationToken,

        code: verificationCode.trim(),

      });

      await saveLoginResponse(mobileSessionStore, res);

      await finishAuth(true, password, true);

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



  return (

    <AuthScreenLayout loading={loading} error={error} onErrorDismiss={() => setError(null)}>

      <AuthPanelTransition anim={modeAnim}>

        <AuthLogo />



        <View style={authStyles.formStack}>

          {mode === "login" || mode === "register" ? (

            <>

              <AuthField

                icon="mail"

                placeholder="Email"

                autoCapitalize="none"

                keyboardType="email-address"

                textContentType="emailAddress"

                autoComplete="email"

                value={email}

                onChangeText={setEmail}

              />

              <AuthField

                icon="lock"

                placeholder="Пароль"

                secureTextEntry={!showPassword}

                showPasswordToggle

                secureVisible={showPassword}

                onToggleSecure={() => setShowPassword((v) => !v)}

                textContentType={mode === "register" ? "newPassword" : "password"}

                autoComplete={mode === "register" ? "password-new" : "password"}

                value={password}

                onChangeText={setPassword}

              />

            </>

          ) : (

            <>

              <AuthField icon="mail" placeholder="Email" editable={false} value={email} whiteTheme />

              <AuthField

                icon="lock"

                placeholder="Код из сообщения"

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



          {mode === "register" ? (

            <AuthField

              icon="lock"

              placeholder="Подтверждение пароля"

              secureTextEntry

              textContentType="newPassword"

              autoComplete="password-new"

              value={confirmPassword}

              onChangeText={setConfirmPassword}

            />

          ) : null}



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



          {devVerificationHint && mode === "verify" ? (

            <Text style={authStyles.devHint}>

              Локальная разработка: код подтверждения{" "}

              <Text style={authStyles.devHintStrong}>{devVerificationHint}</Text> (SMTP не настроен).

            </Text>

          ) : null}



          <AuthSubmitButton

            label={

              mode === "login" ? (awaitingTwoFactor ? "Подтвердить" : "Войти") : mode === "register" ? "Создать аккаунт" : "Подтвердить"

            }

            loading={loading}

            whiteTheme={whiteTheme}

            onPress={onSubmit}

          />

        </View>



        {mode === "login" ? (

          <AuthFooterLinks variant="login" onCreate={goRegister} />

        ) : mode === "register" ? (

          <AuthFooterLinks variant="register" onLogin={goLogin} />

        ) : (

          <AuthFooterLinks variant="verify" onWrongEmail={goRegisterFromVerify} onLogin={goLogin} />

        )}

      </AuthPanelTransition>

    </AuthScreenLayout>

  );

}


