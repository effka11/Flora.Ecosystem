import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultMobileDir = path.resolve(scriptDir, "..", "Apps", "Mobile");
const mobileDir = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : defaultMobileDir;
const packagePath = path.join(mobileDir, "package.json");
const moduleName = "flora-apk-updater";
const playStoreBuild = process.env.FLORA_DISABLE_SIDELOAD_UPDATES === "1";

const raw = fs.readFileSync(packagePath, "utf8");
const pkg = JSON.parse(raw);
pkg.expo ??= {};
pkg.expo.autolinking ??= {};
pkg.expo.autolinking.android ??= {};

const previous = pkg.expo.autolinking.android.exclude ?? [];
const next = playStoreBuild
  ? Array.from(new Set([...previous, moduleName]))
  : previous.filter((name) => name !== moduleName);

if (
  previous.length !== next.length ||
  previous.some((name, index) => name !== next[index])
) {
  pkg.expo.autolinking.android.exclude = next;
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

console.log(
  `flora-apk-updater autolinking: ${playStoreBuild ? "excluded (Play)" : "enabled (sideload/dev)"}`,
);
