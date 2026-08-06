#!/usr/bin/env node
/**
 * Slopsquat CI CLI: provenance (lockfile origins) + names/registry scan + allowlist.
 *
 * Repo root resolution: if process.cwd() contains package-lock.json, use cwd
 * (CI / repo-root runs). Otherwise walk parents for package-lock.json; if none,
 * fall back to the parent of Tools/ (…/Tools/slopsquat → repo root).
 *
 * Config and allowlist are always loaded from this tool directory (import.meta.url),
 * not from cwd. Live network goes through registry.mjs (retries 5xx/429, fail-closed).
 * Offline unit coverage: `node --test Tools/slopsquat` (fake fetch inject).
 * Exit 0 when both checks are clean; exit 1 on any finding (fail-closed).
 */

import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllowlist } from './lib/allowlist.mjs';
import { checkProvenance } from './lib/provenance.mjs';
import { scanNames } from './lib/names.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(TOOL_DIR, 'config.json');
const ALLOWLIST_PATH = path.join(TOOL_DIR, 'allowlist.json');

/** Parallel registry checks (rate limits handled inside registry.mjs). */
const SCAN_CONCURRENCY = 16;

/**
 * @param {string} filePath
 */
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer cwd when it is the repo root (has package-lock.json); else walk up;
 * finally assume Tools/slopsquat → ../../.
 * @returns {Promise<string>}
 */
async function resolveRepoRoot() {
  const cwd = path.resolve(process.cwd());
  if (await pathExists(path.join(cwd, 'package-lock.json'))) {
    return cwd;
  }

  let dir = cwd;
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (await pathExists(path.join(dir, 'package-lock.json'))) {
      return dir;
    }
  }

  return path.resolve(TOOL_DIR, '..', '..');
}

/**
 * @param {Array<{ file?: string, package?: string, message: string }>} findings
 */
function printProvenanceFindings(findings) {
  for (const f of findings) {
    const pkg = f.package ? ` [${f.package}]` : '';
    const file = f.file ? `${f.file}` : '(unknown)';
    console.error(`provenance:${pkg} ${file}: ${f.message}`);
  }
}

/**
 * @param {Array<{
 *   ecosystem?: string,
 *   name?: string,
 *   code?: string,
 *   message: string,
 *   source?: string,
 * }>} findings
 */
function printNameFindings(findings) {
  for (const f of findings) {
    const eco = f.ecosystem ?? '?';
    const name = f.name ?? '?';
    const code = f.code ? ` (${f.code})` : '';
    const src = f.source ? ` @ ${f.source}` : '';
    console.error(`names: [${eco}] ${name}${code}${src}: ${f.message}`);
  }
}

async function main() {
  const rootDir = await resolveRepoRoot();
  const allowlist = await loadAllowlist(ALLOWLIST_PATH);

  const provenance = await checkProvenance({ rootDir });
  if (!provenance.ok) {
    printProvenanceFindings(provenance.findings);
  }

  const names = await scanNames({
    rootDir,
    config: CONFIG_PATH,
    allowlist,
    concurrency: SCAN_CONCURRENCY,
  });
  if (!names.ok) {
    printNameFindings(names.findings);
  }

  if (provenance.ok && names.ok) {
    console.log(
      `slopsquat: ok (root=${rootDir}; checked=${names.checked.length}; allowlisted=${names.skippedAllowlisted.length})`,
    );
    process.exit(0);
  }

  const n = provenance.findings.length + names.findings.length;
  console.error(`slopsquat: FAILED with ${n} finding(s)`);
  process.exit(1);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`slopsquat: fatal: ${msg}`);
  process.exit(1);
});
