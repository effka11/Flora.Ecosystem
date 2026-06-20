import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "node_modules", "@react-native", "gradle-plugin", "settings.gradle.kts");

if (!fs.existsSync(target)) {
  process.exit(0);
}

const before = fs.readFileSync(target, "utf8");
const after = before.replace(
  /foojay-resolver-convention"\)\.version\("0\.5\.0"\)/,
  'foojay-resolver-convention").version("1.0.0")',
);

if (after === before) {
  if (!after.includes('foojay-resolver-convention").version("1.0.0")')) {
    console.warn("[patch-rn-foojay] Unexpected @react-native/gradle-plugin settings.gradle.kts shape");
  }
  process.exit(0);
}

fs.writeFileSync(target, after);
console.log("[patch-rn-foojay] Updated foojay-resolver-convention to 1.0.0 for Gradle 9");
