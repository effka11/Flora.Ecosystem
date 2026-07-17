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
const before = gradle;

const mavenCoordRe =
  /implementation\s+'com\.arthenica:ffmpeg-kit-'\s*\+\s*safePackageName\(safeExtGet\('ffmpegKitPackage',\s*'https'\)\)\s*\+\s*':' \+\s*safePackageVersion\(safeExtGet\('ffmpegKitPackage',\s*'https'\)\)/;

const localAarLines = `implementation(name: 'ffmpeg-kit-full-gpl', ext: 'aar')
  implementation 'com.arthenica:smart-exception-java:0.2.1'`;

if (mavenCoordRe.test(gradle)) {
  gradle = gradle.replace(mavenCoordRe, localAarLines);
} else if (!gradle.includes("implementation(name: 'ffmpeg-kit-full-gpl'")) {
  throw new Error(
    "[patch-ffmpeg-kit] unrecognized ffmpeg-kit dependency in " + androidGradlePath,
  );
}

if (!gradle.includes('dirs "$rootDir/libs"')) {
  const withFlatDir = gradle.replace(
    /(repositories\s*\{\s*\n\s*mavenCentral\(\)\s*\n\s*google\(\))/m,
    `$1
  flatDir {
    dirs "$rootDir/libs"
  }`,
  );
  if (withFlatDir === gradle) {
    throw new Error(
      "[patch-ffmpeg-kit] could not add flatDir to repositories in " +
        androidGradlePath,
    );
  }
  gradle = withFlatDir;
}

if (gradle.includes("com.arthenica:ffmpeg-kit-")) {
  throw new Error(
    "[patch-ffmpeg-kit] Maven ffmpeg-kit coordinate still present in " +
      androidGradlePath,
  );
}

if (!gradle.includes("classpath 'com.android.tools.build:gradle:")) {
  throw new Error(
    "[patch-ffmpeg-kit] buildscript classpath missing in " + androidGradlePath,
  );
}

if (gradle !== before) {
  fs.writeFileSync(androidGradlePath, gradle);
  console.log("[patch-ffmpeg-kit] android/build.gradle -> local AAR + flatDir");
} else {
  console.log("[patch-ffmpeg-kit] android/build.gradle already patched");
}
