const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // .prebuild-stage*: локальные staging-каталоги expo prebuild (gitignored) — не линтить,
    // иначе lint недетерминирован между локальной машиной и CI.
    ignores: ["dist/*", ".expo/*", ".prebuild-stage*/**", "android_gen/**"],
  },
]);
