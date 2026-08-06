/**
 * Collect package/crate names from lockfiles + install commands in docs/scripts,
 * filter allowlist / local-only deps, then run registry 404 + fresh-squat checks.
 * Does not process.exit — callers (check.mjs) own exit codes.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isAllowlisted, loadAllowlist } from './allowlist.mjs';
import { createRegistryClient } from './registry.mjs';

const DOC_EXTENSIONS = new Set([
  '.md',
  '.mdc',
  '.ps1',
  '.yml',
  '.yaml',
  '.mjs',
  '.ts',
  '.tsx',
  '.sh',
  '.json',
]);

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'Local']);

/**
 * Plan: skip Tools/slopsquat/fixtures/. Also skip this tool's *.test.mjs (phantom names).
 * Lib/CLI sources must not contain live install-command examples that the walker would parse.
 */
const SKIP_REL_PREFIXES = ['Tools/slopsquat/fixtures'];

/**
 * Install / add / executor commands only — must NOT match `npm run`, `npm test`, etc.
 * Horizontal whitespace only between cmd and args so a bare install on its own line
 * cannot pull a following `npm run …` line into the arg capture.
 * Captures command + remainder of the same line; callers cut shell chaining.
 */
const INSTALL_CMD_RE =
  /(?:^|[\s;|&`'"])((?:npm[ \t]+i(?:nstall)?|npx|pnpm[ \t]+add|yarn[ \t]+add|bunx|cargo[ \t]+add))[ \t]+([^\n\r#]+)/gi;

const PACKAGE_NAME_RE =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*|[a-z0-9-~][a-z0-9-._~]*)$/i;

const CRATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * @typedef {{ ecosystem: 'npm' | 'crates', name: string, source: string }} NameHit
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   findings: Array<{
 *     ecosystem: string,
 *     name: string,
 *     code: string,
 *     message: string,
 *     source?: string,
 *     ageDays?: number,
 *     downloads?: number,
 *   }>,
 *   checked: NameHit[],
 *   skippedAllowlisted: NameHit[],
 *   skippedLocal: NameHit[],
 * }} ScanResult
 */

/**
 * Extract bare npm package name from a lockfile `packages` map key.
 * @param {string} key
 * @param {{ name?: string }} entry
 */
export function npmNameFromLockKey(key, entry) {
  if (entry?.name) return entry.name;
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  if (idx !== -1) return key.slice(idx + marker.length);
  return key || null;
}

/**
 * True for npm lock entries that resolve only locally (no public registry).
 * @param {{ resolved?: string, link?: boolean }} entry
 */
export function isNpmLocalOnly(entry) {
  if (!entry || typeof entry !== 'object') return true;
  if (entry.link === true) return true;
  const resolved = entry.resolved;
  if (resolved == null || resolved === '') return true;
  if (/^(file:|link:)/i.test(resolved)) return true;
  // Workspace link often stores a relative path without protocol when link:true;
  // if resolved is not an http(s) URL, treat as non-registry skip.
  if (!/^https?:\/\//i.test(resolved)) return true;
  return false;
}

/**
 * @param {string} lockPath
 * @returns {Promise<NameHit[]>}
 */
export async function collectNpmNamesFromLockfile(lockPath) {
  const raw = await readFile(lockPath, 'utf8');
  const lock = JSON.parse(raw);
  /** @type {Map<string, NameHit>} */
  const out = new Map();
  const packages = lock.packages ?? {};

  for (const [key, entry] of Object.entries(packages)) {
    if (!key) continue;
    if (isNpmLocalOnly(entry)) continue;
    const name = npmNameFromLockKey(key, entry);
    if (!name) continue;
    if (!out.has(name)) {
      out.set(name, {
        ecosystem: 'npm',
        name,
        source: `${lockPath}#${key}`,
      });
    }
  }

  // Legacy dependencies tree (lockfileVersion 1 / nested)
  const walkDeps = (deps, prefix) => {
    if (!deps || typeof deps !== 'object') return;
    for (const [name, entry] of Object.entries(deps)) {
      if (!entry || typeof entry !== 'object') continue;
      if (isNpmLocalOnly(entry) && entry.resolved == null && !entry.version) {
        // skip empty
      }
      if (entry.resolved != null || entry.version != null) {
        if (!isNpmLocalOnly(entry) && entry.resolved) {
          if (!out.has(name)) {
            out.set(name, {
              ecosystem: 'npm',
              name,
              source: `${lockPath}#dependencies:${prefix}${name}`,
            });
          }
        } else if (isNpmLocalOnly(entry)) {
          // skip local
        } else if (entry.version && !entry.resolved) {
          // version-only without resolved — still a named dep; include for scan
          if (!out.has(name)) {
            out.set(name, {
              ecosystem: 'npm',
              name,
              source: `${lockPath}#dependencies:${prefix}${name}`,
            });
          }
        }
      }
      if (entry.dependencies) {
        walkDeps(entry.dependencies, `${prefix}${name}/`);
      }
    }
  };
  walkDeps(lock.dependencies, '');

  return [...out.values()];
}

/**
 * Parse Cargo.lock [[package]] tables.
 * @param {string} text
 */
export function parseCargoLockPackages(text) {
  /** @type {Array<{ name?: string, version?: string, source?: string, checksum?: string }>} */
  const pkgs = [];
  /** @type {{ name?: string, version?: string, source?: string, checksum?: string }} */
  let cur = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '[[package]]') {
      if (cur.name) pkgs.push(cur);
      cur = {};
      continue;
    }
    const m = line.match(/^(name|version|source|checksum)\s*=\s*"([^"]*)"/);
    if (m) cur[/** @type {'name'|'version'|'source'|'checksum'} */ (m[1])] = m[2];
  }
  if (cur.name) pkgs.push(cur);
  return pkgs;
}

/**
 * Path-only / non-registry+ crates are auto-skipped (same idea as provenance).
 * @param {{ source?: string }} pkg
 */
export function isCratesRegistryPackage(pkg) {
  const source = pkg?.source;
  if (!source) return false;
  return source.startsWith('registry+');
}

/**
 * @param {string} lockPath
 * @returns {Promise<NameHit[]>}
 */
export async function collectCrateNamesFromLockfile(lockPath) {
  const text = await readFile(lockPath, 'utf8');
  const pkgs = parseCargoLockPackages(text);
  /** @type {Map<string, NameHit>} */
  const out = new Map();
  for (const pkg of pkgs) {
    if (!pkg.name) continue;
    if (!isCratesRegistryPackage(pkg)) continue;
    if (!out.has(pkg.name)) {
      out.set(pkg.name, {
        ecosystem: 'crates',
        name: pkg.name,
        source: `${lockPath}#${pkg.name}`,
      });
    }
  }
  return [...out.values()];
}

/**
 * Strip npm version suffix: `foo@1.2.3` / `@scope/pkg@1.2.3`.
 * @param {string} spec
 */
export function stripNpmVersion(spec) {
  if (!spec) return spec;
  if (spec.startsWith('@')) {
    const secondAt = spec.indexOf('@', 1);
    if (secondAt !== -1) return spec.slice(0, secondAt);
    return spec;
  }
  const at = spec.indexOf('@');
  if (at > 0) return spec.slice(0, at);
  return spec;
}

/**
 * Skip non-registry install specs (file:/link:/git:/github:/http(s):/workspace:).
 * @param {string} spec
 */
export function isNonRegistryNpmSpec(spec) {
  return /^(file:|link:|git\+|git:|github:|gist:|bitbucket:|gitlab:|https?:|workspace:|npm:)/i.test(
    spec,
  );
}

/**
 * True for path-like / URL-like / numeric tokens that must never be package names.
 * Scoped npm names (`@scope/pkg`, optional `@version`) are allowed — only path-like
 * `/` (e.g. `./foo`, `foo/bar`) is rejected.
 * @param {string} tok
 */
function isRejectedInstallToken(tok) {
  if (!tok) return true;
  if (/^\d+$/.test(tok)) return true;
  if (/^[./\\~]/.test(tok) || tok.includes('\\')) return true;
  if (tok.includes('/')) {
    const bare = stripNpmVersion(tok.replace(/[,]+$/, ''));
    if (!PACKAGE_NAME_RE.test(bare)) return true;
  }
  if (/\.(mjs|cjs|js|ts|tsx|json|wasm|exe|bin)$/i.test(tok)) return true;
  if (/^(https?:|git\+|git:|github:|file:|link:|workspace:)/i.test(tok)) return true;
  return false;
}

/**
 * @param {string} name
 * @param {'npm' | 'crates'} ecosystem
 */
function isPackageLikeName(name, ecosystem) {
  if (!name || /^\d+$/.test(name)) return false;
  if (ecosystem === 'crates') return CRATE_NAME_RE.test(name);
  return PACKAGE_NAME_RE.test(name);
}

/**
 * Cut shell chaining so install args stop before a following run-script segment.
 * @param {string} argLine
 */
function firstShellSegment(argLine) {
  return argLine.split(/(?:&&|\|\||[;|])/).map((s) => s.trim())[0] ?? '';
}

/**
 * @param {string} cmd
 * @param {string} argLine
 * @param {string} source
 * @returns {NameHit[]}
 */
export function parseInstallArgLine(cmd, argLine, source) {
  const cmdNorm = cmd.trim();
  const ecosystem = /^cargo[ \t]+add$/i.test(cmdNorm) ? 'crates' : 'npm';
  const isExecutor = /^(npx|bunx)$/i.test(cmdNorm);
  const segment = firstShellSegment(argLine);
  const tokens = segment.split(/\s+/).filter(Boolean);
  /** @type {NameHit[]} */
  const hits = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('-')) {
      // Flags that take a value
      if (
        /^(--save-exact|--save-optional|--save-peer|--save-dev|--save-prod|--workspace|--features|-F|--package|-p|--path|--git|--branch|--tag|--rev|--registry|--index|--vers|--version|-E|-D|-P|-O)$/i.test(
          tok,
        ) ||
        /^--[a-z-]+=/.test(tok)
      ) {
        if (
          !tok.includes('=') &&
          /^(--features|-F|--package|-p|--path|--git|--branch|--tag|--rev|--registry|--index|--vers|--version)$/i.test(
            tok,
          ) &&
          i + 1 < tokens.length
        ) {
          i += 1;
        }
        continue;
      }
      continue;
    }

    // Stop on shell redirects / comments remnants
    if (/^[<>|&]/.test(tok) || tok.startsWith('#')) break;

    if (isRejectedInstallToken(tok)) {
      if (isExecutor) break;
      continue;
    }

    if (ecosystem === 'crates') {
      const name = tok.split('@')[0];
      if (isPackageLikeName(name, 'crates')) {
        hits.push({ ecosystem: 'crates', name, source });
      }
      continue;
    }

    // npm family
    let spec = tok.replace(/[,]+$/, '');
    if (isNonRegistryNpmSpec(spec) || isRejectedInstallToken(spec)) {
      if (isExecutor) break;
      continue;
    }
    const name = stripNpmVersion(spec);
    if (!name || !isPackageLikeName(name, 'npm')) {
      if (isExecutor) break;
      continue;
    }
    hits.push({ ecosystem: 'npm', name, source });
    // npx / bunx: package is the first non-flag token; rest are CLI args
    if (isExecutor) break;
  }

  return hits;
}

/**
 * @param {string} text
 * @param {string} source
 * @returns {NameHit[]}
 */
export function collectNamesFromText(text, source) {
  /** @type {NameHit[]} */
  const hits = [];
  INSTALL_CMD_RE.lastIndex = 0;
  let m;
  while ((m = INSTALL_CMD_RE.exec(text)) !== null) {
    const cmd = m[1];
    const argLine = m[2];
    hits.push(...parseInstallArgLine(cmd, argLine, `${source}:${m.index}`));
  }
  return hits;
}

/**
 * @param {string} relPosix
 */
function shouldSkipRelPath(relPosix) {
  const parts = relPosix.split('/');
  if (parts.some((p) => SKIP_DIR_NAMES.has(p))) return true;
  for (const prefix of SKIP_REL_PREFIXES) {
    if (relPosix === prefix || relPosix.startsWith(`${prefix}/`)) return true;
  }
  // Offline unit tests under the tool carry phantom names — never scan them live.
  if (
    relPosix.startsWith('Tools/slopsquat/') &&
    /\.test\.mjs$/i.test(parts[parts.length - 1] ?? '')
  ) {
    return true;
  }
  const base = parts[parts.length - 1] ?? '';
  if (base === 'package-lock.json' || base === 'Cargo.lock') return true;
  return false;
}

/**
 * Walk repo for docs/scripts install-command names.
 * @param {string} rootDir
 * @returns {Promise<NameHit[]>}
 */
export async function collectNamesFromDocs(rootDir) {
  const root = path.resolve(rootDir);
  /** @type {NameHit[]} */
  const hits = [];

  /** @type {string[]} */
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        if (shouldSkipRelPath(rel)) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (shouldSkipRelPath(rel)) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!DOC_EXTENSIONS.has(ext)) continue;
      let text;
      try {
        text = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      hits.push(...collectNamesFromText(text, rel));
    }
  }

  return hits;
}

/**
 * Union of lockfile + docs names (deduped by ecosystem+name; first source wins).
 * @param {{
 *   rootDir: string,
 *   npmLockPaths?: string[],
 *   cargoLockPath?: string | null,
 * }} opts
 * @returns {Promise<NameHit[]>}
 */
export async function collectAllNames(opts) {
  const rootDir = path.resolve(opts.rootDir);
  const npmLockPaths = opts.npmLockPaths ?? [
    path.join(rootDir, 'package-lock.json'),
    path.join(rootDir, 'Apps', 'Web', 'package-lock.json'),
  ];
  const cargoLockPath =
    opts.cargoLockPath === null
      ? null
      : (opts.cargoLockPath ?? path.join(rootDir, 'Cargo.lock'));

  /** @type {NameHit[]} */
  const all = [];
  for (const lockPath of npmLockPaths) {
    try {
      all.push(...(await collectNpmNamesFromLockfile(lockPath)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`failed reading npm lockfile ${lockPath}: ${msg}`);
    }
  }
  if (cargoLockPath) {
    try {
      all.push(...(await collectCrateNamesFromLockfile(cargoLockPath)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`failed reading Cargo.lock ${cargoLockPath}: ${msg}`);
    }
  }
  all.push(...(await collectNamesFromDocs(rootDir)));

  /** @type {Map<string, NameHit>} */
  const dedup = new Map();
  for (const hit of all) {
    const key = `${hit.ecosystem}:${hit.name}`;
    if (!dedup.has(key)) dedup.set(key, hit);
  }
  return [...dedup.values()];
}

/**
 * @param {string | object} configOrPath
 */
async function resolveConfig(configOrPath) {
  if (typeof configOrPath === 'string') {
    const raw = await readFile(configOrPath, 'utf8');
    return JSON.parse(raw);
  }
  return configOrPath;
}

/**
 * @param {string | object} allowlistOrPath
 */
async function resolveAllowlist(allowlistOrPath) {
  if (typeof allowlistOrPath === 'string') {
    return loadAllowlist(allowlistOrPath);
  }
  return allowlistOrPath;
}

/**
 * Run async work over items with a fixed worker-pool (no extra deps).
 * Results are collected by input index for stable ordering.
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, concurrency, fn) {
  const results = /** @type {R[]} */ (new Array(items.length));
  if (items.length === 0) return results;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/**
 * High-level scan: collect → allowlist filter → registry checks.
 * @param {{
 *   rootDir: string,
 *   config: string | object,
 *   allowlist: string | object,
 *   npmLockPaths?: string[],
 *   cargoLockPath?: string | null,
 *   concurrency?: number,
 *   fetch?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   registry?: ReturnType<typeof createRegistryClient>,
 * }} opts
 * @returns {Promise<ScanResult>}
 */
export async function scanNames(opts) {
  const config = await resolveConfig(opts.config);
  const allowlist = await resolveAllowlist(opts.allowlist);
  const concurrency = opts.concurrency ?? 16;
  const client =
    opts.registry ??
    createRegistryClient(config, {
      fetch: opts.fetch,
      now: opts.now,
      sleep: opts.sleep,
    });

  const collected = await collectAllNames({
    rootDir: opts.rootDir,
    npmLockPaths: opts.npmLockPaths,
    cargoLockPath: opts.cargoLockPath,
  });

  /** @type {NameHit[]} */
  const skippedAllowlisted = [];
  /** @type {NameHit[]} */
  const toCheck = [];

  for (const hit of collected) {
    if (isAllowlisted(hit.name, allowlist)) {
      skippedAllowlisted.push(hit);
      continue;
    }
    toCheck.push(hit);
  }

  const checkResults = await mapPool(toCheck, concurrency, async (hit) => {
    const result =
      hit.ecosystem === 'crates'
        ? await client.checkCratesPackage(hit.name)
        : await client.checkNpmPackage(hit.name);
    return { hit, result };
  });

  /** @type {ScanResult['findings']} */
  const findings = [];
  /** @type {NameHit[]} */
  const checked = [];

  for (const item of checkResults) {
    checked.push(item.hit);
    if (!item.result.ok && item.result.finding) {
      findings.push({
        ...item.result.finding,
        source: item.hit.source,
      });
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    checked,
    skippedAllowlisted,
    skippedLocal: [],
  };
}
