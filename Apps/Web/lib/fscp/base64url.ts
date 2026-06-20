const encoder = new TextEncoder();

export function utf8Bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Base64url decode (no padding). Throws if invalid. */
export function fromBase64Url(s: string): Uint8Array {
  const t = s.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 === 0 ? "" : "=".repeat(4 - (t.length % 4));
  const bin = atob(t + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Standard base64 decode with optional padding. */
export function fromBase64Flexible(s: string): Uint8Array {
  const t = s.trim();
  try {
    return fromBase64Url(t);
  } catch {
    const pad = t.length % 4 === 0 ? "" : "=".repeat(4 - (t.length % 4));
    const bin = atob(t + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
}
