const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const requireFromExpo = createRequire(require.resolve("expo/package.json"));
let configPlugins;
try {
  configPlugins = requireFromExpo("@expo/config-plugins");
} catch {
  configPlugins = require("@expo/config-plugins");
}

const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = configPlugins;

const TARGET_NAME = "FloraSecurePushNSE";

function securePushIds(config) {
  const bundle = config.ios?.bundleIdentifier ?? "social.flora.mobile";
  return {
    bundle,
    extensionBundle: `${bundle}.SecurePushNSE`,
    appGroup: `group.${bundle}.securepush`,
    keychainGroup: `${bundle}.securepush`,
  };
}

function withSecurePushAndroid(config) {
  return withAndroidManifest(config, (cfg) => {
    AndroidConfig.Permissions.ensurePermissions(cfg.modResults, [
      "android.permission.POST_NOTIFICATIONS",
    ]);
    return cfg;
  });
}

function withSecurePushEntitlements(config) {
  const ids = securePushIds(config);
  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults["com.apple.security.application-groups"] = [ids.appGroup];
    cfg.modResults["keychain-access-groups"] = [
      `$(AppIdentifierPrefix)${ids.keychainGroup}`,
    ];
    return cfg;
  });
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.FloraSecurePushAppGroup = ids.appGroup;
    cfg.modResults.FloraSecurePushKeychainGroup =
      `$(AppIdentifierPrefix)${ids.keychainGroup}`;
    cfg.modResults.UIBackgroundModes = [
      ...new Set([...(cfg.modResults.UIBackgroundModes ?? []), "remote-notification"]),
    ];
    return cfg;
  });
}

function withSecurePushTargetFiles(config) {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const source = path.join(cfg.modRequest.projectRoot, "targets", TARGET_NAME);
      const destination = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.cpSync(source, destination, { recursive: true });
      return cfg;
    },
  ]);
}

function withSecurePushXcodeTarget(config) {
  const ids = securePushIds(config);
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const existing = project.pbxNativeTargetSection();
    const existingEntry = Object.values(existing).find(
      (entry) => entry && typeof entry === "object" && entry.name === TARGET_NAME,
    );
    if (existingEntry) return cfg;

    const target = project.addTarget(
      TARGET_NAME,
      "app_extension",
      TARGET_NAME,
      ids.extensionBundle,
    );
    const targetPath = path.join(TARGET_NAME, "NotificationService.swift");
    const headerPath = path.join(TARGET_NAME, `${TARGET_NAME}-Bridging-Header.h`);
    const infoPath = path.join(TARGET_NAME, "Info.plist");
    const entitlementPath = path.join(TARGET_NAME, `${TARGET_NAME}.entitlements`);
    const group = project.addPbxGroup(
      [
        "NotificationService.swift",
        `${TARGET_NAME}-Bridging-Header.h`,
        "Info.plist",
        `${TARGET_NAME}.entitlements`,
      ],
      TARGET_NAME,
      TARGET_NAME,
    );
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);
    project.addBuildPhase(
      [targetPath],
      "PBXSourcesBuildPhase",
      "Sources",
      target.uuid,
      "app_extension",
    );
    if (typeof project.addFramework === "function") {
      project.addFramework(
        "../modules/flora-secure-push/ios/FSCPMobileFFI.xcframework",
        {
          target: target.uuid,
          customFramework: true,
          embed: false,
          link: true,
          sign: false,
        },
      );
    }
    project.addBuildPhase(
      [],
      "PBXFrameworksBuildPhase",
      "Frameworks",
      target.uuid,
      "app_extension",
    );
    project.addBuildPhase(
      [],
      "PBXResourcesBuildPhase",
      "Resources",
      target.uuid,
      "app_extension",
    );
    const configList =
      project.pbxXCConfigurationList()[
        target.pbxNativeTarget.buildConfigurationList
      ];
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const entry of configList.buildConfigurations) {
      const buildSettings = configurations[entry.value].buildSettings;
      Object.assign(buildSettings, {
        INFOPLIST_FILE: `"${infoPath}"`,
        CODE_SIGN_ENTITLEMENTS: `"${entitlementPath}"`,
        SWIFT_OBJC_BRIDGING_HEADER: `"${headerPath}"`,
        PRODUCT_BUNDLE_IDENTIFIER: `"${ids.extensionBundle}"`,
        FLORA_SECURE_PUSH_APP_GROUP: `"${ids.appGroup}"`,
        FLORA_SECURE_PUSH_KEYCHAIN_GROUP: `"${ids.keychainGroup}"`,
        IPHONEOS_DEPLOYMENT_TARGET: "15.1",
        SWIFT_VERSION: "5.0",
      });
    }
    return cfg;
  });
}

module.exports = function withFloraSecurePush(config) {
  config = withSecurePushAndroid(config);
  config = withSecurePushEntitlements(config);
  config = withSecurePushTargetFiles(config);
  return withSecurePushXcodeTarget(config);
};
