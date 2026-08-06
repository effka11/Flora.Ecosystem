/**
 * Offline fake fetch for slopsquat unit tests.
 * Throws if a URL is not handled — never hits the live network.
 */

/**
 * Fixed "now" for deterministic ageDays (2026-08-06).
 */
export const FIXED_NOW_MS = Date.parse('2026-08-06T12:00:00.000Z');

/** ISO timestamp for a package created `days` before FIXED_NOW_MS. */
export function createdIsoDaysAgo(days) {
  return new Date(FIXED_NOW_MS - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * @param {ResponseInit & { json?: unknown }} init
 */
function jsonResponse(status, json) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a fetch stub from a package map.
 *
 * @param {Record<string, {
 *   notFound?: boolean,
 *   createdDaysAgo?: number,
 *   downloads?: number,
 * }>} packages keyed by bare npm name
 * @returns {typeof fetch}
 */
export function createOfflineNpmFetch(packages) {
  /**
   * @param {Parameters<typeof fetch>} args
   */
  return async function offlineFetch(...args) {
    const url = String(args[0]);

    // Metadata: https://registry.npmjs.org/<name>
    const metaMatch = url.match(
      /^https:\/\/registry\.npmjs\.org\/([^/?#]+)$/,
    );
    if (metaMatch) {
      const encoded = metaMatch[1];
      const name = decodeURIComponent(encoded.replace(/%2F/gi, '/'));
      const entry = packages[name];
      if (!entry) {
        throw new Error(`offline fetch: unexpected npm metadata URL: ${url}`);
      }
      if (entry.notFound) {
        return jsonResponse(404, { error: 'Not found' });
      }
      const created = createdIsoDaysAgo(entry.createdDaysAgo ?? 100);
      return jsonResponse(200, {
        name,
        time: { created },
      });
    }

    // Downloads: https://api.npmjs.org/downloads/point/last-month/<name>
    const dlMatch = url.match(
      /^https:\/\/api\.npmjs\.org\/downloads\/point\/last-month\/([^/?#]+)$/,
    );
    if (dlMatch) {
      const encoded = dlMatch[1];
      const name = decodeURIComponent(encoded.replace(/%2F/gi, '/'));
      const entry = packages[name];
      if (!entry) {
        throw new Error(`offline fetch: unexpected npm downloads URL: ${url}`);
      }
      if (entry.notFound) {
        return jsonResponse(404, { error: 'Not found' });
      }
      return jsonResponse(200, {
        downloads: entry.downloads ?? 0,
        package: name,
      });
    }

    throw new Error(`offline fetch: unexpected URL (live network forbidden): ${url}`);
  };
}

/** Fetch that always throws — asserts no registry I/O. */
export function createThrowingFetch() {
  return async function throwingFetch(...args) {
    throw new Error(
      `offline fetch: unexpected call (live network forbidden): ${String(args[0])}`,
    );
  };
}
