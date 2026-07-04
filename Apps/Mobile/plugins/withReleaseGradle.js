const { createRequire } = require("module");

const requireFromExpo = createRequire(require.resolve("expo/package.json"));

let configPlugins;
try {
  configPlugins = requireFromExpo("@expo/config-plugins");
} catch {
  configPlugins = require("@expo/config-plugins");
}

const { withGradleProperties } = configPlugins;

/** Release APK: more JVM heap for D8 dex merge; ARM-only ABIs (no x86 emulator libs). */
const RELEASE_GRADLE_PROPS = [
  ["org.gradle.jvmargs", "-Xmx6144m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8"],
  ["org.gradle.parallel", "false"],
  ["reactNativeArchitectures", "arm64-v8a,armeabi-v7a"],
];

function upsertGradleProperty(entries, key, value) {
  const list = entries ?? [];
  const existing = list.find((e) => e.type === "property" && e.key === key);
  if (existing) {
    existing.value = value;
  } else {
    list.push({ type: "property", key, value });
  }
  return list;
}

module.exports = function withReleaseGradle(config) {
  return withGradleProperties(config, (mod) => {
    let entries = mod.modResults ?? [];
    for (const [key, value] of RELEASE_GRADLE_PROPS) {
      entries = upsertGradleProperty(entries, key, value);
    }
    mod.modResults = entries;
    return mod;
  });
};
