/**
 * Ensures ffmpeg-kit-full-gpl.aar exists for Android Gradle (offline-friendly).
 * Checks: android_gen/libs, Apps/Mobile/vendor, then downloads from GitHub.
 */
import { existsSync, mkdirSync, copyFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mobile = join(root, "Apps", "Mobile");
const aarName = "ffmpeg-kit-full-gpl.aar";
const urlCandidates = [
  "https://github.com/NooruddinLakhani/ffmpeg-kit-full-gpl/releases/download/v1.0.0/ffmpeg-kit-full-gpl.aar",
  "https://raw.githubusercontent.com/NooruddinLakhani/ffmpeg-kit-full-gpl/v1.0.0/ffmpeg-kit-full-gpl.aar",
];

const targets = [
  join(mobile, "android_gen", "libs", aarName),
  join(mobile, "android", "libs", aarName),
];

const MIN_AAR_BYTES = 5_000_000;
const vendor = join(mobile, "vendor", aarName);

function isValidAar(path) {
  try {
    return existsSync(path) && statSync(path).size >= MIN_AAR_BYTES;
  } catch {
    return false;
  }
}

async function download(dest) {
  mkdirSync(dirname(dest), { recursive: true });
  let lastError = null;
  for (const candidate of urlCandidates) {
    try {
      const res = await fetch(candidate, {
        redirect: "follow",
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_AAR_BYTES) {
        throw new Error(`too small (${buf.length} bytes)`);
      }
      writeFileSync(dest, buf);
      console.log(`[ffmpeg-aar] downloaded from ${candidate}`);
      return;
    } catch (e) {
      lastError = e;
      console.warn(`[ffmpeg-aar] failed ${candidate}: ${e.message}`);
    }
  }
  throw lastError ?? new Error("all download URLs failed");
}

async function main() {
  const primary = targets[0];
  let sourcePath = null;

  for (const dest of targets) {
    if (isValidAar(dest)) {
      sourcePath = dest;
      console.log(`[ffmpeg-aar] OK ${dest}`);
      break;
    }
  }

  if (!sourcePath && isValidAar(vendor)) {
    sourcePath = vendor;
  }

  if (!sourcePath) {
    for (const dest of [...targets, vendor]) {
      if (existsSync(dest) && !isValidAar(dest)) {
        try { unlinkSync(dest); } catch { /* ignore */ }
      }
    }
    console.log(`[ffmpeg-aar] downloading -> ${primary}`);
    await download(primary);
    if (!isValidAar(primary)) {
      throw new Error(`Downloaded AAR is missing or too small: ${primary}`);
    }
    sourcePath = primary;
    mkdirSync(dirname(vendor), { recursive: true });
    copyFileSync(primary, vendor);
    console.log(`[ffmpeg-aar] saved vendor copy at ${vendor}`);
  }

  for (const dest of targets) {
    if (isValidAar(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(sourcePath, dest);
    console.log(`[ffmpeg-aar] copied -> ${dest}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
