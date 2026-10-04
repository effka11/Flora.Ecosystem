import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Web / static-render stand-in for `react-native-quick-crypto`.
 *
 * The real package installs JSI at import time and throws when
 * `NativeModules.QuickCrypto` is missing. Expo web (`output: "static"`)
 * evaluates that graph in the browser and in the Node renderer, so the
 * native package cannot be on the web module graph. Metro aliases the
 * package name here only when `platform === "web"`.
 *
 * Covers the call sites in this app: `install()`, `randomBytes`,
 * `webcrypto.subtle`, and `createHash("sha256").update(utf8).digest("hex")`.
 */

const textEncoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function createHash(algorithm: string) {
  if (algorithm !== "sha256") {
    throw new Error(`quick-crypto web shim: unsupported hash ${algorithm}`);
  }
  const parts: Uint8Array[] = [];
  const api = {
    update(data: string | Uint8Array) {
      parts.push(typeof data === "string" ? textEncoder.encode(data) : data);
      return api;
    },
    digest(encoding: "hex") {
      if (encoding !== "hex") {
        throw new Error(`quick-crypto web shim: unsupported digest encoding ${String(encoding)}`);
      }
      let total = 0;
      for (const part of parts) total += part.length;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        merged.set(part, offset);
        offset += part.length;
      }
      return toHex(sha256(merged));
    },
  };
  return api;
}

/** Browser and Node already expose `globalThis.crypto`; do not replace it. */
export function install(): void {}

const QuickCrypto = {
  install,
  randomBytes,
  createHash,
  get webcrypto() {
    return globalThis.crypto;
  },
};

export default QuickCrypto;
