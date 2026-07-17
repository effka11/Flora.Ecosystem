import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const repoRoot = resolve(webRoot, "..", "..");

const build = spawnSync(
  "cargo",
  [
    "build",
    "-p",
    "frc-i-wasm",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
  ],
  { cwd: repoRoot, encoding: "utf8", stdio: "inherit", shell: process.platform === "win32" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const metadata = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
  cwd: repoRoot,
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (metadata.status !== 0) {
  process.stderr.write(metadata.stderr);
  process.exit(metadata.status ?? 1);
}
const targetDirectory = JSON.parse(metadata.stdout) as { target_directory: string };
const source = join(
  targetDirectory.target_directory,
  "wasm32-unknown-unknown",
  "release",
  "frc_i_wasm.wasm",
);
const outputDirectory = join(webRoot, "public", "frc");
mkdirSync(outputDirectory, { recursive: true });
copyFileSync(source, join(outputDirectory, "frc_i_wasm.wasm"));
