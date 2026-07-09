import type { ConfigContext, ExpoConfig } from "expo/config";

const PRODUCTION_PACKAGE = "social.flora.mobile";
const DEVELOPMENT_PACKAGE = "social.flora.mobile.dev";

const PROD_ICON = "./assets/images/icon.png";
const DEV_ICON = "./assets/images/icon-dev.png";
const ADAPTIVE_FOREGROUND = "./assets/images/android-icon-foreground.png";
const ADAPTIVE_MONOCHROME = "./assets/images/android-icon-monochrome.png";
const PROD_ADAPTIVE_BG = "#2c3527";
const DEV_ADAPTIVE_BG = "#0c0c0c";

export const isDevelopmentVariant = () => process.env.APP_VARIANT === "development";

export default ({ config }: ConfigContext): ExpoConfig => {
  const isDev = isDevelopmentVariant();
  const plugins = [...(config.plugins ?? [])];

  if (isDev && !plugins.some((p) => p === "expo-dev-client" || (Array.isArray(p) && p[0] === "expo-dev-client"))) {
    plugins.unshift("expo-dev-client");
  }

  if (!isDev && !plugins.some((p) => p === "./plugins/withGoogleServices" || (Array.isArray(p) && p[0] === "./plugins/withGoogleServices"))) {
    plugins.push("./plugins/withGoogleServices");
  }

  if (!isDev && !plugins.some((p) => p === "./plugins/withReleaseGradle" || (Array.isArray(p) && p[0] === "./plugins/withReleaseGradle"))) {
    plugins.push("./plugins/withReleaseGradle");
  }

  const androidBase = { ...config.android };
  const adaptiveIcon = {
    ...(androidBase?.adaptiveIcon ?? {}),
    foregroundImage: ADAPTIVE_FOREGROUND,
    monochromeImage: ADAPTIVE_MONOCHROME,
    backgroundColor: isDev ? DEV_ADAPTIVE_BG : PROD_ADAPTIVE_BG,
  };

  return {
    ...config,
    name: isDev ? "Flora Dev" : (config.name ?? "Flora"),
    slug: config.slug ?? "flora-mobile",
    scheme: isDev ? "flora-dev" : (config.scheme ?? "flora"),
    icon: isDev ? DEV_ICON : (config.icon ?? PROD_ICON),
    plugins,
    extra: {
      ...(config.extra ?? {}),
      pushEnabled: !isDev,
    },
    ios: {
      ...config.ios,
      bundleIdentifier: isDev ? DEVELOPMENT_PACKAGE : config.ios?.bundleIdentifier ?? PRODUCTION_PACKAGE,
    },
    android: isDev
      ? {
          ...androidBase,
          package: DEVELOPMENT_PACKAGE,
          googleServicesFile: undefined,
          intentFilters: undefined,
          adaptiveIcon,
        }
      : {
          ...androidBase,
          package: androidBase.package ?? PRODUCTION_PACKAGE,
          adaptiveIcon,
        },
  };
};
