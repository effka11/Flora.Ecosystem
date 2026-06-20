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

const { withDangerousMod, withProjectBuildGradle, withAppBuildGradle } = configPlugins;
const { mergeContents } = requireFromExpo("@expo/config-plugins/build/utils/generateCode");

const GOOGLE_SERVICES_CLASSPATH =
  "classpath 'com.google.gms:google-services:4.4.2'";

function resolveGoogleServicesSource(projectRoot) {
  const candidates = [
    path.join(projectRoot, "google-services.json"),
    path.join(projectRoot, "apps", "mobile", "google-services.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function withGoogleServices(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const { projectRoot, platformProjectRoot } = cfg.modRequest;
      const source = resolveGoogleServicesSource(projectRoot);
      if (!source) {
        throw new Error(
          "Missing google-services.json for release Android build. " +
            "Download from Firebase (package social.flora.mobile) to Apps/Mobile/google-services.json",
        );
      }

      const dest = path.join(platformProjectRoot, "app", "google-services.json");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
      return cfg;
    },
  ]);
}

function withGoogleServicesGradle(config) {
  config = withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes("com.google.gms:google-services")) {
      return cfg;
    }
    cfg.modResults.contents = mergeContents({
      tag: "flora-google-services-classpath",
      src: cfg.modResults.contents,
      newSrc: `    ${GOOGLE_SERVICES_CLASSPATH}`,
      anchor: /dependencies\s*\{/,
      offset: 1,
      comment: "//",
    }).contents;
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes("com.google.gms.google-services")) {
      return cfg;
    }
    cfg.modResults.contents += `\napply plugin: 'com.google.gms.google-services'\n`;
    return cfg;
  });

  return config;
}

module.exports = function withFloraGoogleServices(config, props = {}) {
  if (props.enabled === false) return config;
  return withGoogleServices(withGoogleServicesGradle(config));
};
