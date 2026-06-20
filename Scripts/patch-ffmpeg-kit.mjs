import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  path.join(root, "node_modules", "ffmpeg-kit-react-native"),
  path.join(root, "Apps", "Mobile", "node_modules", "ffmpeg-kit-react-native"),
];

const pkgRoot = candidates.find((p) => fs.existsSync(p));
if (!pkgRoot) {
  process.exit(0);
}

const podspecPath = path.join(pkgRoot, "ffmpeg-kit-react-native.podspec");
const androidGradlePath = path.join(pkgRoot, "android", "build.gradle");

let podspec = fs.readFileSync(podspecPath, "utf8");
if (!podspec.includes("s.default_subspec   = 'full-gpl'")) {
  podspec = podspec.replace(
    /s\.default_subspec\s*=\s*'https'/,
    "s.default_subspec   = 'full-gpl'",
  );
  fs.writeFileSync(podspecPath, podspec);
  console.log("[patch-ffmpeg-kit] podspec default_subspec -> full-gpl");
}

let gradle = fs.readFileSync(androidGradlePath, "utf8");

if (!gradle.includes("implementation(name: 'ffmpeg-kit-full-gpl'")) {
  gradle = gradle.replace(
    /dependencies\s*\{\s*\n\s*api 'com\.facebook\.react:react-native:\+'\s*\n\s*implementation 'com\.arthenica:ffmpeg-kit-[^']+:[^']+'\s*\n\}/m,
    `dependencies {
  api 'com.facebook.react:react-native:+'
  implementation(name: 'ffmpeg-kit-full-gpl', ext: 'aar')
  implementation 'com.arthenica:smart-exception-java:0.2.1'
}`,
  );
}

const flatDirBlock = `
  flatDir {
    dirs "$rootDir/libs"
  }`;

if (!gradle.includes('dirs "$rootDir/libs"')) {
  gradle = gradle.replace(
    /(repositories\s*\{\s*\n\s*mavenCentral\(\)\s*\n\s*google\(\))/m,
    `$1${flatDirBlock}`,
  );
}

fs.writeFileSync(androidGradlePath, gradle);
console.log("[patch-ffmpeg-kit] android/build.gradle -> local AAR + flatDir");
