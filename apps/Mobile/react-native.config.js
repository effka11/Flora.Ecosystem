/**
 * Disable native linking of flora-apk-updater for Play/EAS AAB builds.
 * EAS production sets FLORA_DISABLE_SIDELOAD_UPDATES=1.
 */
const disableSideload = process.env.FLORA_DISABLE_SIDELOAD_UPDATES === "1";

module.exports = {
  dependencies: {
    "flora-apk-updater": {
      platforms: {
        android: disableSideload ? null : {},
        ios: null,
      },
    },
  },
};
