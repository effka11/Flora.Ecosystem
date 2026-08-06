/**
 * Offline names / registry composition tests (injected fake fetch).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAllowlist, isAllowlisted } from './lib/allowlist.mjs';
import {
  collectAllNames,
  collectNamesFromText,
  scanNames,
} from './lib/names.mjs';
import {
  FIXED_NOW_MS,
  createOfflineNpmFetch,
  createThrowingFetch,
} from './fixtures/offline-fetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const CONFIG_PATH = path.join(FIXTURES, 'config.json');
const ALLOWLIST_PATH = path.join(FIXTURES, 'allowlist.json');

const emptyAllowlist = { exact: [], namePrefixes: [] };

async function scanFixture(fixtureName, packages, allowlist = emptyAllowlist) {
  return scanNames({
    rootDir: path.join(FIXTURES, fixtureName),
    config: CONFIG_PATH,
    allowlist,
    npmLockPaths: [],
    cargoLockPath: null,
    concurrency: 4,
    fetch: createOfflineNpmFetch(packages),
    now: () => FIXED_NOW_MS,
    sleep: async () => {},
  });
}

describe('collectNamesFromText', () => {
  test('extracts npm install package names', () => {
    const hits = collectNamesFromText(
      'run: npm install next && npm run build',
      'sample.md',
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, 'next');
    assert.equal(hits[0].ecosystem, 'npm');
  });

  test('collects scoped npm name from npm install', () => {
    const hits = collectNamesFromText(
      'npm install @scope/pkg',
      'sample.md',
    );
    assert.ok(hits.some((h) => h.name === '@scope/pkg' && h.ecosystem === 'npm'));
  });
});

describe('collectAllNames skip self', () => {
  test('docs collection skips fixtures and tool unit tests', async () => {
    const repoRoot = path.resolve(HERE, '../..');
    const hits = await collectAllNames({
      rootDir: repoRoot,
      npmLockPaths: [],
      cargoLockPath: null,
    });
    const selfHits = hits.filter((h) => {
      const src = String(h.source).replace(/\\/g, '/');
      return (
        src.includes('Tools/slopsquat/fixtures/') ||
        /Tools\/slopsquat\/[^/]+\.test\.mjs/.test(src)
      );
    });
    assert.equal(
      selfHits.length,
      0,
      `unexpected self-sourced hits: ${JSON.stringify(selfHits.slice(0, 5))}`,
    );
  });
});

describe('scanNames offline', () => {
  test('phantom name in markdown fails (404)', async () => {
    const result = await scanFixture('phantom', {
      'totally-fake-phantom-xyz': { notFound: true },
    });

    assert.equal(result.ok, false);
    const finding = result.findings.find(
      (f) => f.name === 'totally-fake-phantom-xyz',
    );
    assert.ok(finding);
    assert.equal(finding.code, 'not_found');
  });

  test('npm install next passes with old high-download registry stub', async () => {
    const result = await scanFixture('pass-next', {
      next: { createdDaysAgo: 100, downloads: 50_000 },
    });

    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
    assert.ok(result.checked.some((h) => h.name === 'next'));
  });

  test('fresh squat: age 5d / downloads 10 fails', async () => {
    const result = await scanFixture('fresh-squat-fail', {
      'fresh-squat-low-dl': { createdDaysAgo: 5, downloads: 10 },
    });

    assert.equal(result.ok, false);
    const finding = result.findings.find(
      (f) => f.name === 'fresh-squat-low-dl',
    );
    assert.ok(finding);
    assert.equal(finding.code, 'fresh_squat');
    assert.ok(finding.ageDays !== undefined && finding.ageDays <= 30);
    assert.equal(finding.downloads, 10);
  });

  test('fresh squat: age 5d / downloads 50_000 passes', async () => {
    const result = await scanFixture('fresh-squat-pass', {
      'fresh-squat-high-dl': { createdDaysAgo: 5, downloads: 50_000 },
    });

    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
    assert.ok(result.checked.some((h) => h.name === 'fresh-squat-high-dl'));
  });

  test('prefix @flora/… / flora- and exact entry are allowlisted (skip registry)', async () => {
    const allowlist = await loadAllowlist(ALLOWLIST_PATH);
    assert.equal(isAllowlisted('@flora/client-core', allowlist), true);
    assert.equal(isAllowlisted('flora-helper-pkg', allowlist), true);
    assert.equal(isAllowlisted('trusted-exact-pkg', allowlist), true);

    const rootDir = path.join(FIXTURES, 'allowlisted');
    const result = await scanNames({
      rootDir,
      config: CONFIG_PATH,
      allowlist,
      // Scoped @flora/… is collected from lock (install-token / rejection);
      // exact + flora- prefix from docs.md install lines.
      npmLockPaths: [path.join(rootDir, 'package-lock.json')],
      cargoLockPath: null,
      concurrency: 4,
      fetch: createThrowingFetch(),
      now: () => FIXED_NOW_MS,
      sleep: async () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
    assert.equal(result.checked.length, 0);
    const skippedNames = result.skippedAllowlisted.map((h) => h.name).sort();
    assert.deepEqual(skippedNames, [
      '@flora/client-core',
      'flora-helper-pkg',
      'trusted-exact-pkg',
    ]);
  });
});
