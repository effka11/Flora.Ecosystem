const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = {
  // Root hoists semver@6; reanimated needs semver@7 subpath exports (disableHierarchicalLookup blocks nested lookup).
  semver: path.resolve(
    workspaceRoot,
    "node_modules/react-native-reanimated/node_modules/semver",
  ),
};

// react-native-libsodium imports @noble/hashes v1 subpaths; root workspace hoists @noble/hashes v2.
const NOBLE_HASHES_ALIASES = {
  "@noble/hashes/sha256": "@noble/hashes/sha2.js",
  "@noble/hashes/hkdf": "@noble/hashes/hkdf.js",
};

/**
 * NodeNext-style `foo.js` imports that actually point at TypeScript sources.
 * Relative: Packages/Products sources. Package: `@flora/*` (exports map to `.ts`).
 * Do not remap real `.js` files in node_modules (e.g. @noble/hashes).
 */
function shouldRemapJsToTs(moduleName) {
  if (!moduleName.endsWith(".js")) return false;
  return moduleName.startsWith(".") || moduleName.startsWith("@flora/");
}

/**
 * Custom resolver must chain via `context.resolveRequest` so Expo can still
 * apply tsconfig paths (`@/…`), autolinking, etc. (see withMetroResolvers).
 */
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const nobleAlias = NOBLE_HASHES_ALIASES[moduleName];
  if (nobleAlias) {
    try {
      return context.resolveRequest(context, nobleAlias, platform);
    } catch {
      // fall through
    }
  }

  if (shouldRemapJsToTs(moduleName)) {
    const stem = moduleName.slice(0, -3);
    for (const candidate of [stem, `${stem}.ts`, `${stem}.tsx`]) {
      try {
        return context.resolveRequest(context, candidate, platform);
      } catch {
        // try next candidate
      }
    }
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
