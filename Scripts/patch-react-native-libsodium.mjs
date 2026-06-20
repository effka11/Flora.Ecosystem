import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cmakePath = path.join(root, "node_modules", "react-native-libsodium", "android", "CMakeLists.txt");

if (!fs.existsSync(cmakePath)) {
  process.exit(0);
}

const marker = "# [flora] normalize NODE_MODULES_DIR for Windows CMake escapes";
const before = fs.readFileSync(cmakePath, "utf8");

if (before.includes(marker)) {
  process.exit(0);
}

const insert = `${marker}
if(DEFINED NODE_MODULES_DIR)
  file(TO_CMAKE_PATH "\${NODE_MODULES_DIR}" NODE_MODULES_DIR)
  string(REPLACE "\\\\" "/" NODE_MODULES_DIR "\${NODE_MODULES_DIR}")
endif()

`;

const needle = "cmake_minimum_required(VERSION 3.4.1)\n\n";
if (!before.includes(needle)) {
  console.warn("[patch-react-native-libsodium] Unexpected CMakeLists.txt shape");
  process.exit(0);
}

fs.writeFileSync(cmakePath, before.replace(needle, needle + insert));
console.log("[patch-react-native-libsodium] Fixed Windows NODE_MODULES_DIR paths in CMakeLists.txt");
