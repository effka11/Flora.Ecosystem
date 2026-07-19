const { createRequire } = require("module");

const requireFromExpo = createRequire(require.resolve("expo/package.json"));

let configPlugins;
try {
  configPlugins = requireFromExpo("@expo/config-plugins");
} catch {
  configPlugins = require("@expo/config-plugins");
}

const { withAndroidManifest, AndroidConfig } = configPlugins;

const INSTALL_PERMISSIONS = [
  "android.permission.REQUEST_INSTALL_PACKAGES",
  "android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION",
  "android.permission.POST_NOTIFICATIONS",
];

const FLORA_FMS =
  "expo.modules.floraapkupdater.FloraAppUpdateMessagingService";
const EXPO_FMS =
  "expo.modules.notifications.service.ExpoFirebaseMessagingService";

/**
 * Sideload-only: PackageInstaller permissions + replace Expo FMS with Flora wrapper
 * so app_update data messages are handled natively without dropping DM pushes.
 */
function withFloraApkUpdater(config) {
  return withAndroidManifest(config, (cfg) => {
    AndroidConfig.Permissions.ensurePermissions(cfg.modResults, INSTALL_PERMISSIONS);

    const manifest = cfg.modResults.manifest;
    const app = manifest.application?.[0];
    if (!app) return cfg;

    const services = app.service ?? [];
    for (const service of services) {
      const name = service.$?.["android:name"];
      if (!name) continue;
      const isExpo =
        name === EXPO_FMS ||
        name.endsWith(".ExpoFirebaseMessagingService") ||
        name.includes("ExpoFirebaseMessagingService");
      const isFlora =
        name === FLORA_FMS || name.endsWith(".FloraAppUpdateMessagingService");
      if (isExpo && !isFlora) {
        // Disable Expo's service so only Flora's wrapper receives MESSAGING_EVENT.
        service.$["android:enabled"] = "false";
      }
    }

    return cfg;
  });
}

module.exports = withFloraApkUpdater;
