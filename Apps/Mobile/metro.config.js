const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const { resolve: resolveMetro } = require("metro-resolver");

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

function isWorkspaceSource(origin) {
  const normalized = origin.replace(/\\/g, "/");
  return normalized.includes("/Packages/") || normalized.includes("/Apps/");
}

function resolveIfFound(context, moduleName, platform) {
  const resolved = resolveMetro(context, moduleName, platform);
  return resolved.type === "failed" ? null : resolved;
}

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const nobleAlias = NOBLE_HASHES_ALIASES[moduleName];
  if (nobleAlias) {
    const resolved = resolveIfFound(context, nobleAlias, platform);
    if (resolved) {
      return resolved;
    }
  }

  const origin = context.originModulePath ?? "";
  if (isWorkspaceSource(origin) && moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    for (const ext of [".ts", ".tsx"]) {
      const resolved = resolveIfFound(
        context,
        moduleName.replace(/\.js$/, ext),
        platform,
      );
      if (resolved) {
        return resolved;
      }
    }
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }

  return resolveMetro(context, moduleName, platform);
};

module.exports = config;
