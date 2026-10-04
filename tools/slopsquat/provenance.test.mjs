/**
 * Offline provenance unit tests (lockfile text only — no network).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProvenance } from './lib/provenance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

describe('checkProvenance', () => {
  test('foreign registry resolved URL fails', async () => {
    const rootDir = path.join(FIXTURES, 'foreign-registry');
    const result = await checkProvenance({
      rootDir,
      npmLockPaths: ['package-lock.json'],
      cargoLockPath: null,
    });

    assert.equal(result.ok, false);
    assert.ok(result.findings.length >= 1);
    const foreign = result.findings.find((f) =>
      /foreign or disallowed npm registry/i.test(f.message),
    );
    assert.ok(foreign, 'expected foreign-registry finding');
    assert.match(foreign.message, /evil\.example/);
    assert.equal(foreign.package, 'evil-pkg');
  });

  test('registry.npmjs.org resolved URL with integrity passes', async () => {
    const rootDir = path.join(FIXTURES, 'clean-npm');
    const result = await checkProvenance({
      rootDir,
      npmLockPaths: ['package-lock.json'],
      cargoLockPath: null,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
  });

  test('Cargo git+ source fails', async () => {
    const rootDir = path.join(FIXTURES, 'cargo-git');
    const result = await checkProvenance({
      rootDir,
      npmLockPaths: [],
      cargoLockPath: 'Cargo.lock',
    });

    assert.equal(result.ok, false);
    const git = result.findings.find((f) => /git dependency/i.test(f.message));
    assert.ok(git, 'expected git+ finding');
    assert.equal(git.package, 'evil-git-crate');
    assert.match(git.message, /evil\.example/);
  });

  test('Cargo non-crates.io registry fails', async () => {
    const rootDir = path.join(FIXTURES, 'cargo-bad-registry');
    const result = await checkProvenance({
      rootDir,
      npmLockPaths: [],
      cargoLockPath: 'Cargo.lock',
    });

    assert.equal(result.ok, false);
    const bad = result.findings.find((f) =>
      /non-crates\.io registry/i.test(f.message),
    );
    assert.ok(bad, 'expected non-crates.io finding');
    assert.equal(bad.package, 'evil-registry-crate');
  });

  test('crates.io registry package with checksum passes; path-only skipped', async () => {
    const rootDir = path.join(FIXTURES, 'cargo-clean');
    const result = await checkProvenance({
      rootDir,
      npmLockPaths: [],
      cargoLockPath: 'Cargo.lock',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
  });
});
