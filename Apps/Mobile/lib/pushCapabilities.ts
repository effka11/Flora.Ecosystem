import Constants from "expo-constants";

const PRODUCTION_ANDROID_PACKAGE = "social.flora.mobile";
const DEVELOPMENT_ANDROID_PACKAGE = "social.flora.mobile.dev";

/** FCM / OS push — только release APK. Flora Dev: SSE + polling. */
export function isNativePushEnabled(): boolean {
  const androidPackage = Constants.expoConfig?.android?.package;
  if (androidPackage === DEVELOPMENT_ANDROID_PACKAGE) return false;
  if (androidPackage === PRODUCTION_ANDROID_PACKAGE) return true;

  const iosBundle = Constants.expoConfig?.ios?.bundleIdentifier;
  if (iosBundle === DEVELOPMENT_ANDROID_PACKAGE) return false;
  if (iosBundle === PRODUCTION_ANDROID_PACKAGE) return true;

  const extra = Constants.expoConfig?.extra as { pushEnabled?: boolean } | undefined;
  return extra?.pushEnabled === true;
}
