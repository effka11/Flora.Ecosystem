/**
 * Allowlist for slopsquat name checks.
 * Match: exact.includes(name) OR name.startsWith(any namePrefixes entry).
 * exact[] holds bare package/crate name strings; prefixes e.g. "@flora/", "flora-".
 */

import { readFile } from 'node:fs/promises';

/**
 * @typedef {{ exact: string[], namePrefixes: string[] }} Allowlist
 */

/**
 * @param {string} path
 * @returns {Promise<Allowlist>}
 */
export async function loadAllowlist(path) {
  const raw = await readFile(path, 'utf8');
  const data = JSON.parse(raw);
  return {
    exact: Array.isArray(data.exact) ? data.exact.map(String) : [],
    namePrefixes: Array.isArray(data.namePrefixes)
      ? data.namePrefixes.map(String)
      : [],
  };
}

/**
 * @param {string} name
 * @param {Allowlist} allowlist
 * @returns {boolean}
 */
export function isAllowlisted(name, allowlist) {
  if (!name || !allowlist) return false;
  const exact = allowlist.exact ?? [];
  if (exact.includes(name)) return true;
  const prefixes = allowlist.namePrefixes ?? [];
  return prefixes.some((p) => name.startsWith(p));
}
