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

/**
 * Sideload-only PackageInstaller permissions. FCM service ownership belongs to
 * the always-linked flora-secure-push module.
 */
function withFloraApkUpdater(config) {
  return withAndroidManifest(config, (cfg) => {
    AndroidConfig.Permissions.ensurePermissions(cfg.modResults, INSTALL_PERMISSIONS);
    return cfg;
  });
}

module.exports = withFloraApkUpdater;
