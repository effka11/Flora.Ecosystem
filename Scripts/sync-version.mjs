#!/usr/bin/env node
/**
 * Single source of truth: repo root VERSION.
 * Propagates ecosystem + product versions to package manifests and flora-api manifest.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = join(root, "VERSION");

function readManifest() {
  if (!existsSync(versionPath)) {
    throw new Error(`Missing ${versionPath}`);
  }
  const manifest = JSON.parse(readFileSync(versionPath, "utf8"));
  if (typeof manifest.ecosystem !== "string" || !manifest.ecosystem.trim()) {
    throw new Error("VERSION.ecosystem must be a non-empty semver string");
  }
  if (typeof manifest.products?.social !== "string" || !manifest.products.social.trim()) {
    throw new Error("VERSION.products.social must be a non-empty semver string");
  }
  return manifest;
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function patchPackageJson(relativePath, version) {
  const path = join(root, relativePath);
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (pkg.version === version) return false;
  pkg.version = version;
  writeJson(path, pkg);
  return true;
}

function patchAppJson(version) {
  const path = join(root, "Apps", "Mobile", "app.json");
  const app = JSON.parse(readFileSync(path, "utf8"));
  if (app.expo?.version === version) return false;
  app.expo.version = version;
  writeJson(path, app);
  return true;
}

function writeApiManifest(manifest) {
  const path = join(root, "Backend", "flora-versions.json");
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (prev === next) return false;
  writeFileSync(path, next, "utf8");
  return true;
}

function patchBackendCargoToml(ecosystemVersion) {
  const path = join(root, "Cargo.toml");
  if (!existsSync(path)) return false;
  const toml = readFileSync(path, "utf8");
  const marker = /^version = ".*" # synced-from-VERSION$/m;
  if (!marker.test(toml)) {
    // Workspace may pin version only under [workspace.package]
    const wsMarker = /^version = ".*" # synced-from-VERSION$/m;
    if (!wsMarker.test(toml)) {
      console.warn("Cargo.toml: no 'version = \"...\" # synced-from-VERSION' marker — skip");
      return false;
    }
  }
  const next = toml.replace(marker, `version = "${ecosystemVersion}" # synced-from-VERSION`);
  if (next === toml) return false;
  writeFileSync(path, next, "utf8");
  return true;
}

const manifest = readManifest();
const { ecosystem, products } = manifest;
const social = products.social;

const changes = [];
if (patchPackageJson("Apps/Web/package.json", social)) changes.push(`Apps/Web/package.json → ${social}`);
if (patchPackageJson("Apps/Mobile/package.json", social)) changes.push(`Apps/Mobile/package.json → ${social}`);
if (patchPackageJson("Packages/flora-client-core/package.json", ecosystem)) {
  changes.push(`Packages/flora-client-core/package.json → ${ecosystem}`);
}
if (patchAppJson(social)) changes.push(`Apps/Mobile/app.json → ${social}`);
if (writeApiManifest(manifest)) changes.push("Backend/flora-versions.json");
if (patchBackendCargoToml(ecosystem)) {
  changes.push(`Cargo.toml → ${ecosystem}`);
}

if (changes.length === 0) {
  console.log("VERSION sync: already up to date.");
} else {
  console.log("VERSION sync updated:");
  for (const line of changes) console.log(`  ${line}`);
}
