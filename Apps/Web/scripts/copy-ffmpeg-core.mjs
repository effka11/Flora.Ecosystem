import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "ffmpeg");
const corePkg = path.join(root, "node_modules", "@ffmpeg", "core", "dist", "esm");
const ffmpegUmd = path.join(root, "node_modules", "@ffmpeg", "ffmpeg", "dist", "umd");

await mkdir(outDir, { recursive: true });
await copyFile(path.join(corePkg, "ffmpeg-core.js"), path.join(outDir, "ffmpeg-core.js"));
await copyFile(path.join(corePkg, "ffmpeg-core.wasm"), path.join(outDir, "ffmpeg-core.wasm"));

const umdFiles = await readdir(ffmpegUmd);
const workerName = umdFiles.find((f) => /\.ffmpeg\.js$/.test(f) && f !== "ffmpeg.js");
if (!workerName) {
  throw new Error("Bundled ffmpeg worker not found in @ffmpeg/ffmpeg/dist/umd");
}
await copyFile(path.join(ffmpegUmd, workerName), path.join(outDir, "worker.js"));

console.log(`Copied @ffmpeg/core + bundled worker (${workerName}) to public/ffmpeg`);
