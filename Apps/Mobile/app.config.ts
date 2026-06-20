import type { ConfigContext, ExpoConfig } from "expo/config";

const PRODUCTION_PACKAGE = "social.flora.mobile";
const DEVELOPMENT_PACKAGE = "social.flora.mobile.dev";

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

  const androidBase = { ...config.android };

  return {
    ...config,
    name: isDev ? "Flora Dev" : (config.name ?? "Flora"),
    slug: config.slug ?? "flora-mobile",
    scheme: isDev ? "flora-dev" : (config.scheme ?? "flora"),
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
        }
      : {
          ...androidBase,
          package: androidBase.package ?? PRODUCTION_PACKAGE,
        },
  };
};
