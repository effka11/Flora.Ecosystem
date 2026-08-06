/**
 * Registry clients for npm + crates.io: scoped encoding, User-Agent,
 * retries with fail-closed, 404 and fresh-squat checks.
 * Inject fetch / now / sleep for offline unit tests (no live network by default path).
 *
 * Transient HTTP statuses retried within `config.retries`: 5xx and 429 (rate limit).
 * Persistent failure after retries → fail closed. 404 is never retried.
 */

/**
 * Scoped npm path encoding: replace ONLY the first `/` with `%2F`.
 * @param {string} name
 * @returns {string}
 */
export function encodeNpmPackageName(name) {
  const i = name.indexOf('/');
  if (i === -1) return name;
  return `${name.slice(0, i)}%2F${name.slice(i + 1)}`;
}

/**
 * @typedef {object} RegistryConfig
 * @property {number} ageDays
 * @property {number} maxDownloadsNpmLastMonth
 * @property {number} maxDownloadsCratesAllTime
 * @property {number} retries
 * @property {string} userAgent
 * @property {string} npmRegistryUrl
 * @property {string} npmDownloadsUrlTemplate
 * @property {string} cratesApiUrl
 */

/**
 * @typedef {object} RegistryDeps
 * @property {typeof fetch} [fetch]
 * @property {() => number} [now] ms since epoch
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/**
 * @param {RegistryConfig} config
 * @param {RegistryDeps} [deps]
 */
export function createRegistryClient(config, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const nowFn = deps.now ?? (() => Date.now());
  const sleepFn =
    deps.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retries = Math.max(1, Number(config.retries) || 3);
  const userAgent = config.userAgent;

  /**
   * @param {string} url
   * @returns {Promise<{ ok: true, status: number, json: any } | { ok: false, status: number | null, error: string, failClosed: boolean, notFound: boolean }>}
   */
  async function requestJson(url) {
    let lastError = /** @type {string | null} */ (null);
    let lastStatus = /** @type {number | null} */ (null);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetchFn(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': userAgent,
          },
        });
        lastStatus = res.status;

        if (res.status === 404) {
          return {
            ok: false,
            status: 404,
            error: `HTTP 404 for ${url}`,
            failClosed: false,
            notFound: true,
          };
        }

        if (res.status === 429 || res.status >= 500) {
          lastError = `HTTP ${res.status} for ${url}`;
          if (attempt < retries) {
            await discardResponseBody(res);
            const waitMs =
              res.status === 429
                ? rateLimitBackoffMs(attempt, res.headers)
                : backoffMs(attempt);
            await sleepFn(waitMs);
            continue;
          }
          return {
            ok: false,
            status: res.status,
            error: lastError,
            failClosed: true,
            notFound: false,
          };
        }

        if (!res.ok) {
          // Non-retryable client errors (except 404 / 429 handled above) → fail closed
          const text = await res.text().catch(() => '');
          return {
            ok: false,
            status: res.status,
            error: `HTTP ${res.status} for ${url}${text ? `: ${text.slice(0, 200)}` : ''}`,
            failClosed: true,
            notFound: false,
          };
        }

        const json = await res.json();
        return { ok: true, status: res.status, json };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        lastStatus = null;
        if (attempt < retries) {
          await sleepFn(backoffMs(attempt));
          continue;
        }
        return {
          ok: false,
          status: lastStatus,
          error: lastError ?? 'network error',
          failClosed: true,
          notFound: false,
        };
      }
    }

    return {
      ok: false,
      status: lastStatus,
      error: lastError ?? 'request failed',
      failClosed: true,
      notFound: false,
    };
  }

  /**
   * @param {string} name
   */
  async function fetchNpmMetadata(name) {
    const encoded = encodeNpmPackageName(name);
    const base = config.npmRegistryUrl.replace(/\/$/, '');
    return requestJson(`${base}/${encoded}`);
  }

  /**
   * @param {string} name
   */
  async function fetchNpmDownloads(name) {
    const encoded = encodeNpmPackageName(name);
    const url = config.npmDownloadsUrlTemplate.replaceAll(
      '{package}',
      encoded,
    );
    return requestJson(url);
  }

  /**
   * @param {string} name
   */
  async function fetchCratesMetadata(name) {
    const base = config.cratesApiUrl.replace(/\/$/, '');
    return requestJson(`${base}/${encodeURIComponent(name)}`);
  }

  /**
   * Fresh-squat / phantom check for one npm package.
   * @param {string} name
   * @returns {Promise<{ ok: boolean, finding?: { ecosystem: string, name: string, code: string, message: string, ageDays?: number, downloads?: number } }>}
   */
  async function checkNpmPackage(name) {
    const meta = await fetchNpmMetadata(name);
    if (!meta.ok) {
      if (meta.notFound) {
        return {
          ok: false,
          finding: {
            ecosystem: 'npm',
            name,
            code: 'not_found',
            message: `npm package not found (404): ${name}`,
          },
        };
      }
      return {
        ok: false,
        finding: {
          ecosystem: 'npm',
          name,
          code: 'registry_error',
          message: `npm metadata fail-closed for ${name}: ${meta.error}`,
        },
      };
    }

    const createdRaw = meta.json?.time?.created;
    if (!createdRaw) {
      return {
        ok: false,
        finding: {
          ecosystem: 'npm',
          name,
          code: 'registry_error',
          message: `npm metadata missing time.created for ${name}`,
        },
      };
    }

    const createdMs = Date.parse(createdRaw);
    if (Number.isNaN(createdMs)) {
      return {
        ok: false,
        finding: {
          ecosystem: 'npm',
          name,
          code: 'registry_error',
          message: `npm time.created unparseable for ${name}: ${createdRaw}`,
        },
      };
    }

    const ageDays = (nowFn() - createdMs) / (1000 * 60 * 60 * 24);

    // Old packages cannot match the fresh-squat AND rule; skip downloads API.
    if (ageDays > config.ageDays) {
      return { ok: true };
    }

    const dl = await fetchNpmDownloads(name);
    if (!dl.ok) {
      if (dl.notFound) {
        return {
          ok: false,
          finding: {
            ecosystem: 'npm',
            name,
            code: 'not_found',
            message: `npm downloads not found (404): ${name}`,
          },
        };
      }
      return {
        ok: false,
        finding: {
          ecosystem: 'npm',
          name,
          code: 'registry_error',
          message: `npm downloads fail-closed for ${name}: ${dl.error}`,
        },
      };
    }

    const downloads = Number(dl.json?.downloads);
    if (!Number.isFinite(downloads)) {
      return {
        ok: false,
        finding: {
          ecosystem: 'npm',
          name,
          code: 'registry_error',
          message: `npm downloads field missing for ${name}`,
        },
      };
    }

    if (
      ageDays <= config.ageDays &&
      downloads <= config.maxDownloadsNpmLastMonth
    ) {
      return {
        ok: false,
        finding: {
          ecosystem: 'npm',
          name,
          code: 'fresh_squat',
          message: `fresh squat: npm ${name} age ${ageDays.toFixed(1)}d ≤ ${config.ageDays}d and downloads ${downloads} ≤ ${config.maxDownloadsNpmLastMonth}`,
          ageDays,
          downloads,
        },
      };
    }

    return { ok: true };
  }

  /**
   * Fresh-squat / phantom check for one crates.io package.
   * @param {string} name
   */
  async function checkCratesPackage(name) {
    const meta = await fetchCratesMetadata(name);
    if (!meta.ok) {
      if (meta.notFound) {
        return {
          ok: false,
          finding: {
            ecosystem: 'crates',
            name,
            code: 'not_found',
            message: `crates.io package not found (404): ${name}`,
          },
        };
      }
      return {
        ok: false,
        finding: {
          ecosystem: 'crates',
          name,
          code: 'registry_error',
          message: `crates.io metadata fail-closed for ${name}: ${meta.error}`,
        },
      };
    }

    const crate = meta.json?.crate;
    const createdRaw = crate?.created_at;
    if (!createdRaw) {
      return {
        ok: false,
        finding: {
          ecosystem: 'crates',
          name,
          code: 'registry_error',
          message: `crates.io missing crate.created_at for ${name}`,
        },
      };
    }

    const createdMs = Date.parse(createdRaw);
    if (Number.isNaN(createdMs)) {
      return {
        ok: false,
        finding: {
          ecosystem: 'crates',
          name,
          code: 'registry_error',
          message: `crates.io created_at unparseable for ${name}: ${createdRaw}`,
        },
      };
    }

    const ageDays = (nowFn() - createdMs) / (1000 * 60 * 60 * 24);
    const downloads = Number(crate?.downloads);
    if (!Number.isFinite(downloads)) {
      return {
        ok: false,
        finding: {
          ecosystem: 'crates',
          name,
          code: 'registry_error',
          message: `crates.io downloads missing for ${name}`,
        },
      };
    }

    if (
      ageDays <= config.ageDays &&
      downloads <= config.maxDownloadsCratesAllTime
    ) {
      return {
        ok: false,
        finding: {
          ecosystem: 'crates',
          name,
          code: 'fresh_squat',
          message: `fresh squat: crates ${name} age ${ageDays.toFixed(1)}d ≤ ${config.ageDays}d and downloads ${downloads} ≤ ${config.maxDownloadsCratesAllTime}`,
          ageDays,
          downloads,
        },
      };
    }

    return { ok: true };
  }

  return {
    encodeNpmPackageName,
    fetchNpmMetadata,
    fetchNpmDownloads,
    fetchCratesMetadata,
    checkNpmPackage,
    checkCratesPackage,
    requestJson,
  };
}

/**
 * @param {number} attempt 1-based
 */
function backoffMs(attempt) {
  return 100 * 2 ** (attempt - 1);
}

/**
 * Backoff for HTTP 429: honor Retry-After (seconds) when present, else exponential.
 * @param {number} attempt 1-based
 * @param {Headers | undefined} headers
 */
function rateLimitBackoffMs(attempt, headers) {
  const raw = headers?.get?.('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60_000, Math.max(0, Math.ceil(seconds * 1000)));
    }
  }
  return Math.min(60_000, 1000 * 2 ** (attempt - 1));
}

/**
 * @param {Response} res
 */
async function discardResponseBody(res) {
  try {
    await res.arrayBuffer();
  } catch {
    // ignore drain errors
  }
}

export { backoffMs, rateLimitBackoffMs };
