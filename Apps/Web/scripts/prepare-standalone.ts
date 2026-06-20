import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveStandaloneDir(): string {
  const candidates = [
    path.join(root, ".next", "standalone"),
    path.join(root, ".next", "standalone", "Apps", "Web"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "server.js"))) return dir;
  }
  return candidates[0];
}

const standalone = resolveStandaloneDir();
const serverJs = path.join(standalone, "server.js");

if (!fs.existsSync(serverJs)) {
  console.error("Run `npm run build` first (.next/standalone/server.js is missing).");
  process.exit(1);
}

const publicSrc = path.join(root, "public");
const publicDst = path.join(standalone, "public");
if (fs.existsSync(publicSrc)) {
  fs.cpSync(publicSrc, publicDst, { recursive: true, force: true });
}

const staticSrc = path.join(root, ".next", "static");
const staticDst = path.join(standalone, ".next", "static");
if (!fs.existsSync(staticSrc)) {
  console.error(".next/static is missing. Build output is incomplete.");
  process.exit(1);
}
fs.cpSync(staticSrc, staticDst, { recursive: true, force: true });

console.log("Standalone ready:", standalone);
