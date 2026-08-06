/**
 * Offline check composition / encode / allowlist unit tests.
 * Does not spawn live check.mjs (would hit the network).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAllowlist, isAllowlisted } from './lib/allowlist.mjs';
import { checkProvenance } from './lib/provenance.mjs';
import { scanNames } from './lib/names.mjs';
import {
  encodeNpmPackageName,
  createRegistryClient,
} from './lib/registry.mjs';
import {
  FIXED_NOW_MS,
  createOfflineNpmFetch,
  createThrowingFetch,
} from './fixtures/offline-fetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const CONFIG_PATH = path.join(FIXTURES, 'config.json');
const ALLOWLIST_PATH = path.join(FIXTURES, 'allowlist.json');

describe('encodeNpmPackageName', () => {
  test('encodes scoped package first slash only', () => {
    assert.equal(
      encodeNpmPackageName('@flora/client-core'),
      '@flora%2Fclient-core',
    );
  });

  test('leaves unscoped names unchanged', () => {
    assert.equal(encodeNpmPackageName('next'), 'next');
  });
});

describe('allowlist fixture', () => {
  test('prefix and exact match', async () => {
    const allowlist = await loadAllowlist(ALLOWLIST_PATH);
    assert.equal(isAllowlisted('@flora/anything', allowlist), true);
    assert.equal(isAllowlisted('flora-shared', allowlist), true);
    assert.equal(isAllowlisted('trusted-exact-pkg', allowlist), true);
    assert.equal(isAllowlisted('next', allowlist), false);
  });
});

describe('composition: provenance + names (offline)', () => {
  test('foreign lock fails provenance; phantom markdown fails names', async () => {
    const provenance = await checkProvenance({
      rootDir: path.join(FIXTURES, 'foreign-registry'),
      npmLockPaths: ['package-lock.json'],
      cargoLockPath: null,
    });
    assert.equal(provenance.ok, false);

    const names = await scanNames({
      rootDir: path.join(FIXTURES, 'phantom'),
      config: CONFIG_PATH,
      allowlist: { exact: [], namePrefixes: [] },
      npmLockPaths: [],
      cargoLockPath: null,
      concurrency: 2,
      fetch: createOfflineNpmFetch({
        'totally-fake-phantom-xyz': { notFound: true },
      }),
      now: () => FIXED_NOW_MS,
      sleep: async () => {},
    });
    assert.equal(names.ok, false);
    assert.ok(names.findings.some((f) => f.code === 'not_found'));
  });

  test('registry client uses encoded scoped path in fetch URL', async () => {
    /** @type {string[]} */
    const urls = [];
    const fetchStub = createOfflineNpmFetch({
      '@flora/client-core': { createdDaysAgo: 100 },
    });
    const wrapped = async (...args) => {
      urls.push(String(args[0]));
      return fetchStub(...args);
    };

    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(CONFIG_PATH, 'utf8'),
    );
    const config = JSON.parse(raw);
    const client = createRegistryClient(config, {
      fetch: wrapped,
      now: () => FIXED_NOW_MS,
      sleep: async () => {},
    });

    const result = await client.checkNpmPackage('@flora/client-core');
    assert.equal(result.ok, true);
    assert.ok(
      urls.some((u) =>
        u.includes('registry.npmjs.org/@flora%2Fclient-core'),
      ),
      `expected encoded scoped URL in ${JSON.stringify(urls)}`,
    );
    // Old package: downloads API must not be called.
    assert.ok(
      !urls.some((u) => u.includes('api.npmjs.org')),
      'old package must skip downloads API',
    );
  });

  test('allowlisted names never call fetch', async () => {
    const allowlist = await loadAllowlist(ALLOWLIST_PATH);
    const rootDir = path.join(FIXTURES, 'allowlisted');
    const result = await scanNames({
      rootDir,
      config: CONFIG_PATH,
      allowlist,
      npmLockPaths: [path.join(rootDir, 'package-lock.json')],
      cargoLockPath: null,
      fetch: createThrowingFetch(),
      now: () => FIXED_NOW_MS,
      sleep: async () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.checked.length, 0);
    assert.ok(
      result.skippedAllowlisted.some((h) => h.name === '@flora/client-core'),
    );
    assert.ok(
      result.skippedAllowlisted.some((h) => h.name === 'trusted-exact-pkg'),
    );
  });
});

describe('registry 429 retries', () => {
  test('retries 429 then succeeds (same client path as CLI)', async () => {
    let hits = 0;
    /** @type {typeof fetch} */
    const fetchStub = async () => {
      hits += 1;
      if (hits < 3) {
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return new Response(
        JSON.stringify({
          time: {
            created: new Date(FIXED_NOW_MS - 100 * 864e5).toISOString(),
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const client = createRegistryClient(
      {
        ageDays: 30,
        maxDownloadsNpmLastMonth: 1000,
        maxDownloadsCratesAllTime: 1000,
        retries: 3,
        userAgent: 'test',
        npmRegistryUrl: 'https://registry.npmjs.org',
        npmDownloadsUrlTemplate:
          'https://api.npmjs.org/downloads/point/last-month/{package}',
        cratesApiUrl: 'https://crates.io/api/v1/crates',
      },
      {
        fetch: fetchStub,
        now: () => FIXED_NOW_MS,
        sleep: async () => {},
      },
    );

    const result = await client.checkNpmPackage('lodash');
    assert.equal(result.ok, true);
    assert.equal(hits, 3);
  });

  test('exhausted 429 retries fail closed', async () => {
    let hits = 0;
    /** @type {typeof fetch} */
    const fetchStub = async () => {
      hits += 1;
      return new Response('', { status: 429 });
    };

    const client = createRegistryClient(
      {
        ageDays: 30,
        maxDownloadsNpmLastMonth: 1000,
        maxDownloadsCratesAllTime: 1000,
        retries: 2,
        userAgent: 'test',
        npmRegistryUrl: 'https://registry.npmjs.org',
        npmDownloadsUrlTemplate:
          'https://api.npmjs.org/downloads/point/last-month/{package}',
        cratesApiUrl: 'https://crates.io/api/v1/crates',
      },
      {
        fetch: fetchStub,
        now: () => FIXED_NOW_MS,
        sleep: async () => {},
      },
    );

    const result = await client.checkNpmPackage('lodash');
    assert.equal(result.ok, false);
    assert.equal(result.finding?.code, 'registry_error');
    assert.equal(hits, 2);
  });
});
