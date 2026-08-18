#!/usr/bin/env node
/**
 * Single source of truth: repo root VERSION.
 * Propagates ecosystem + product versions to package manifests and flora-api manifest.
 *
 * Mapping:
 *   products.social  → Apps/Web
 *   products.gov     → Apps/Gov
 *   products.mobile  → Apps/Mobile (package.json + app.json expo.version)
 *   products.fscp    → Products/FSCP
 *   products.frc-i   → Products/FRC
 *   ecosystem        → @flora/client-core, Cargo.toml
 *
 * APK filename, GitHub social/v tag, and the sideload update channel still
 * follow products.social until a dedicated mobile download-channel cutover.
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
  for (const key of ["social", "gov", "mobile", "fscp", "frc-i", "fira"]) {
    if (typeof manifest.products?.[key] !== "string" || !manifest.products[key].trim()) {
      throw new Error(`VERSION.products.${key} must be a non-empty semver string`);
    }
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

function writeVersionsMirror(relativePath, manifest) {
  const path = join(root, relativePath);
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
const gov = products.gov;
const mobile = products.mobile;
const fscp = products.fscp;
const frcI = products["frc-i"];

const changes = [];
if (patchPackageJson("Apps/Web/package.json", social)) changes.push(`Apps/Web/package.json → ${social}`);
if (patchPackageJson("Apps/Gov/package.json", gov)) changes.push(`Apps/Gov/package.json → ${gov}`);
if (patchPackageJson("Apps/Mobile/package.json", mobile)) changes.push(`Apps/Mobile/package.json → ${mobile}`);
if (patchPackageJson("Packages/flora-client-core/package.json", ecosystem)) {
  changes.push(`Packages/flora-client-core/package.json → ${ecosystem}`);
}
if (patchPackageJson("Products/FSCP/package.json", fscp)) {
  changes.push(`Products/FSCP/package.json → ${fscp}`);
}
if (patchPackageJson("Products/FRC/package.json", frcI)) {
  changes.push(`Products/FRC/package.json → ${frcI}`);
}
if (patchAppJson(mobile)) changes.push(`Apps/Mobile/app.json → ${mobile}`);
if (writeVersionsMirror("Backend/flora-versions.json", manifest)) {
  changes.push("Backend/flora-versions.json");
}
if (writeVersionsMirror("flora-versions.json", manifest)) {
  changes.push("flora-versions.json");
}
if (patchBackendCargoToml(ecosystem)) {
  changes.push(`Cargo.toml → ${ecosystem}`);
}

if (changes.length === 0) {
  console.log("VERSION sync: already up to date.");
} else {
  console.log("VERSION sync updated:");
  for (const line of changes) console.log(`  ${line}`);
}
