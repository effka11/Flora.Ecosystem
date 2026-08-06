/**
 * Offline provenance checks for npm package-lock.json and Cargo.lock.
 *
 * Auto-skip (no fail) when there is no public registry resolve:
 * - npm: `file:` / `link:` / workspace link entries (`link: true`) / packages without `resolved`
 * - Cargo: path-only packages (no `source`) / non-`registry+` sources that are absent
 *
 * Registry packages are checked for allowed origin + integrity/checksum only.
 * No network I/O — lockfile text only. Exit codes are the CLI's job, not this module.
 */

import fs from "node:fs/promises";
import path from "node:path";

const NPM_REGISTRY_PREFIX = "https://registry.npmjs.org/";

/** crates.io-style Cargo registry sources (git index + sparse index). */
const CARGO_CRATES_IO_SOURCES = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "registry+sparse+https://index.crates.io/",
]);

const DEFAULT_NPM_LOCK_PATHS = [
  "package-lock.json",
  "Apps/Web/package-lock.json",
];
const DEFAULT_CARGO_LOCK_PATH = "Cargo.lock";

/**
 * @typedef {{ file: string, package?: string, message: string }} ProvenanceFinding
 * @typedef {{ ok: boolean, findings: ProvenanceFinding[] }} ProvenanceResult
 */

/**
 * Check npm + Cargo lockfile provenance (registry host + integrity/checksum).
 *
 * @param {object} [options]
 * @param {string} [options.rootDir=process.cwd()] Repository root for relative lock paths.
 * @param {string[]} [options.npmLockPaths] Paths relative to rootDir (or absolute).
 * @param {string|null} [options.cargoLockPath] Cargo.lock path; `null` skips Cargo.
 * @returns {Promise<ProvenanceResult>}
 */
export async function checkProvenance({
  rootDir = process.cwd(),
  npmLockPaths = DEFAULT_NPM_LOCK_PATHS,
  cargoLockPath = DEFAULT_CARGO_LOCK_PATH,
} = {}) {
  /** @type {ProvenanceFinding[]} */
  const findings = [];
  const root = path.resolve(rootDir);

  for (const lockRel of npmLockPaths ?? []) {
    const file = resolveUnderRoot(root, lockRel);
    await checkNpmLockfile(file, findings);
  }

  if (cargoLockPath != null && cargoLockPath !== "") {
    const file = resolveUnderRoot(root, cargoLockPath);
    await checkCargoLockfile(file, findings);
  }

  return { ok: findings.length === 0, findings };
}

/**
 * @param {string} root
 * @param {string} lockPath
 */
function resolveUnderRoot(root, lockPath) {
  return path.isAbsolute(lockPath) ? path.normalize(lockPath) : path.resolve(root, lockPath);
}

/**
 * @param {string} file
 * @param {ProvenanceFinding[]} findings
 */
async function checkNpmLockfile(file, findings) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === "ENOENT") {
      findings.push({
        file,
        message: "npm lockfile not found",
      });
      return;
    }
    throw err;
  }

  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    findings.push({
      file,
      message: "npm lockfile is not valid JSON",
    });
    return;
  }

  if (lock.packages && typeof lock.packages === "object") {
    for (const [pkgKey, entry] of Object.entries(lock.packages)) {
      checkNpmPackageEntry(file, packageNameFromPackagesKey(pkgKey), entry, findings);
    }
  }

  // package-lock v1 (and nested trees still present in some locks): walk `dependencies`.
  if (lock.dependencies && typeof lock.dependencies === "object") {
    walkNpmDependenciesTree(file, lock.dependencies, findings);
  }
}

/**
 * @param {string} file
 * @param {Record<string, unknown>} deps
 * @param {ProvenanceFinding[]} findings
 */
function walkNpmDependenciesTree(file, deps, findings) {
  for (const [name, entry] of Object.entries(deps)) {
    if (!entry || typeof entry !== "object") continue;
    const obj = /** @type {Record<string, unknown>} */ (entry);
    checkNpmPackageEntry(file, name, obj, findings);
    if (obj.dependencies && typeof obj.dependencies === "object") {
      walkNpmDependenciesTree(
        file,
        /** @type {Record<string, unknown>} */ (obj.dependencies),
        findings,
      );
    }
  }
}

/**
 * @param {string} packagesKey
 * @returns {string|undefined}
 */
function packageNameFromPackagesKey(packagesKey) {
  if (!packagesKey) return undefined;
  const marker = "node_modules/";
  const idx = packagesKey.lastIndexOf(marker);
  if (idx === -1) {
    // Workspace package path (e.g. Apps/Mobile) — not a registry install key.
    return packagesKey;
  }
  return packagesKey.slice(idx + marker.length);
}

/**
 * @param {string} file
 * @param {string|undefined} packageName
 * @param {unknown} entry
 * @param {ProvenanceFinding[]} findings
 */
function checkNpmPackageEntry(file, packageName, entry, findings) {
  if (!entry || typeof entry !== "object") return;
  const pkg = /** @type {Record<string, unknown>} */ (entry);

  // Root "" entry and pure workspace metadata often have no resolved — skip.
  if (pkg.link === true) return;

  const resolved = typeof pkg.resolved === "string" ? pkg.resolved : null;
  if (!resolved) return;

  if (isNpmLocalResolved(resolved)) return;

  if (!resolved.startsWith(NPM_REGISTRY_PREFIX)) {
    findings.push({
      file,
      package: packageName,
      message: `foreign or disallowed npm registry resolved URL: ${resolved}`,
    });
    return;
  }

  const integrity = typeof pkg.integrity === "string" ? pkg.integrity.trim() : "";
  if (!integrity) {
    findings.push({
      file,
      package: packageName,
      message: "registry package missing integrity",
    });
  }
}

/**
 * Local resolves: explicit file:/link: or non-URL path (npm workspace `link: true` targets).
 * @param {string} resolved
 */
function isNpmLocalResolved(resolved) {
  if (resolved.startsWith("file:") || resolved.startsWith("link:")) return true;
  // Relative / absolute filesystem paths without a URL scheme.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(resolved)) return true;
  return false;
}

/**
 * @param {string} file
 * @param {ProvenanceFinding[]} findings
 */
async function checkCargoLockfile(file, findings) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === "ENOENT") {
      findings.push({
        file,
        message: "Cargo.lock not found",
      });
      return;
    }
    throw err;
  }

  for (const pkg of parseCargoPackages(raw)) {
    // Path / workspace members: no source field — auto-skip.
    if (!pkg.source) continue;

    const name = pkg.name || "(unknown)";

    if (pkg.source.startsWith("git+")) {
      findings.push({
        file,
        package: name,
        message: `git dependency source forbidden: ${pkg.source}`,
      });
      continue;
    }

    if (!pkg.source.startsWith("registry+")) {
      findings.push({
        file,
        package: name,
        message: `unknown Cargo source (expected crates.io registry): ${pkg.source}`,
      });
      continue;
    }

    if (!CARGO_CRATES_IO_SOURCES.has(pkg.source)) {
      findings.push({
        file,
        package: name,
        message: `non-crates.io registry source: ${pkg.source}`,
      });
      continue;
    }

    if (!pkg.checksum || !pkg.checksum.trim()) {
      findings.push({
        file,
        package: name,
        message: "registry package missing checksum",
      });
    }
  }
}

/**
 * Minimal Cargo.lock [[package]] field extractor (name/version/source/checksum).
 * @param {string} text
 * @returns {Array<{ name?: string, version?: string, source?: string, checksum?: string }>}
 */
function parseCargoPackages(text) {
  /** @type {Array<{ name?: string, version?: string, source?: string, checksum?: string }>} */
  const packages = [];
  /** @type {{ name?: string, version?: string, source?: string, checksum?: string } | null} */
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    if (line === "[[package]]") {
      if (current) packages.push(current);
      current = {};
      continue;
    }
    if (!current) continue;

    if (line.startsWith("[")) {
      packages.push(current);
      current = null;
      continue;
    }

    const m = line.match(/^(name|version|source|checksum) = "(.*)"\s*$/);
    if (m) {
      const key = /** @type {"name"|"version"|"source"|"checksum"} */ (m[1]);
      current[key] = m[2];
    }
  }

  if (current) packages.push(current);
  return packages;
}

export default checkProvenance;
