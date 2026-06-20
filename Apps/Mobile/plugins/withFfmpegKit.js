const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const requireFromExpo = createRequire(require.resolve("expo/package.json"));

let configPlugins;
try {
  configPlugins = requireFromExpo("@expo/config-plugins");
} catch {
  configPlugins = require("@expo/config-plugins");
}

const { withPlugins, withDangerousMod, withAppBuildGradle, withProjectBuildGradle, withGradleProperties } =
  configPlugins;
const { mergeContents } = requireFromExpo("@expo/config-plugins/build/utils/generateCode");

const DEFAULT_IOS_URL =
  "https://github.com/NooruddinLakhani/ffmpeg-kit-ios-full-gpl/archive/refs/tags/latest.zip";
const DEFAULT_ANDROID_URL =
  "https://github.com/NooruddinLakhani/ffmpeg-kit-full-gpl/releases/download/v1.0.0/ffmpeg-kit-full-gpl.aar";

function withFfmpegKitIos(config, { iosUrl }) {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const { platformProjectRoot } = cfg.modRequest;
      const podspecPath = path.join(platformProjectRoot, "ffmpeg-kit-ios-full-gpl.podspec");
      const podspec = `Pod::Spec.new do |s|
    s.name             = 'ffmpeg-kit-ios-full-gpl'
    s.version          = '6.0'
    s.summary          = 'Self-hosted full-gpl FFmpegKit iOS frameworks (FFmpegKit retirement workaround).'
    s.homepage         = 'https://github.com/arthenica/ffmpeg-kit'
    s.license          = { :type => 'LGPL' }
    s.author           = { 'Flora' => 'dev@flora.social' }
    s.platform         = :ios, '12.1'
    s.static_framework = true
    s.source           = { :http => '${iosUrl}' }
    s.vendored_frameworks = [
      'ffmpeg-kit-ios-full-gpl-latest/ffmpeg-kit-ios-full-gpl/6.0-80adc/libswscale.xcframework',
      'ffmpeg-kit-ios-full-gpl-latest/ffmpeg-kit-ios-full-gpl/6.0-80adc/libswresample.xcframework',
      'ffmpeg-kit-ios-full-gpl-latest/ffmpeg-kit-ios-full-gpl/6.0-80adc/libavutil.xcframework',
      'ffmpeg-kit-ios-full-gpl-latest/ffmpeg-kit-ios-full-gpl/6.0-80adc/libavformat.xcframework',
      'ffmpeg-kit-ios-full-gpl-latest/ffmpeg-kit-ios-full-gpl/6.0-80adc/libavfilter.xcframework',
      'ffmpeg-kit-ios-full-gpl-latest/ffmpeg-kit-ios-full-gpl/6.0-80adc/libavdevice.xcframework',
      'ffmpeg-kit-ios-full-gpl-latest/ffmpeg-kit-ios-full-gpl/6.0-80adc/libavcodec.xcframework',
      'ffmpeg-kit-ios-full-gpl-latest/ffmpeg-kit-ios-full-gpl/6.0-80adc/ffmpegkit.xcframework'
    ]
end
`;
      fs.writeFileSync(podspecPath, podspec);

      const podfilePath = path.join(platformProjectRoot, "Podfile");
      let podfileContent = fs.readFileSync(podfilePath, "utf-8");
      const newPodEntry = `pod 'ffmpeg-kit-ios-full-gpl', :podspec => './ffmpeg-kit-ios-full-gpl.podspec'`;

      if (!podfileContent.includes(newPodEntry)) {
        const anchor = "use_expo_modules!";
        if (podfileContent.includes(anchor)) {
          podfileContent = mergeContents({
            tag: "ffmpeg-kit-custom-pod",
            src: podfileContent,
            newSrc: newPodEntry,
            anchor: new RegExp(`^\\s*${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
            offset: 1,
            comment: "#",
          }).contents;
        } else {
          const appName = cfg.name ?? config.name;
          const targetAnchor = `target '${appName}' do`;
          if (appName && podfileContent.includes(targetAnchor)) {
            podfileContent = mergeContents({
              tag: "ffmpeg-kit-custom-pod-fallback",
              src: podfileContent,
              newSrc: `  ${newPodEntry}`,
              anchor: new RegExp(
                `^\\s*${targetAnchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
              ),
              offset: 1,
              comment: "#",
            }).contents;
          }
        }
        fs.writeFileSync(podfilePath, podfileContent);
      }
      return cfg;
    },
  ]);
}

function withFfmpegKitAndroid(config, { androidUrl }) {
  config = withAppBuildGradle(config, (cfg) => {
    let buildGradle = cfg.modResults.contents;

    const importUrl = "import java.net.URL";
    if (!buildGradle.includes(importUrl)) {
      buildGradle = mergeContents({
        tag: "ffmpeg-kit-import-url",
        src: buildGradle,
        newSrc: importUrl,
        anchor: /^/,
        offset: 0,
        comment: "//",
      }).contents;
    }

    const appFlatDirLibsPath = "${projectDir}/../libs";
    const appFlatDirRepo = `
    repositories {
        flatDir {
            dirs "${appFlatDirLibsPath}"
        }
    }`;

    if (
      !buildGradle.match(
        new RegExp(
          `repositories\\s*\\{[\\s\\S]*?flatDir\\s*\\{[\\s\\S]*?dirs\\s*['"]${appFlatDirLibsPath.replace(
            /[$.]/g,
            "\\$&",
          )}['"]`,
        ),
      )
    ) {
      buildGradle = mergeContents({
        tag: "ffmpeg-kit-app-flatdir-repo",
        src: buildGradle,
        newSrc: appFlatDirRepo,
        anchor: /android\s*\{/,
        offset: 1,
        comment: "//",
      }).contents;
    }

    const newDependencies = `
    implementation(name: 'ffmpeg-kit-full-gpl', ext: 'aar')
    implementation 'com.arthenica:smart-exception-java:0.2.1'`;
    if (!buildGradle.includes("name: 'ffmpeg-kit-full-gpl', ext: 'aar'")) {
      buildGradle = mergeContents({
        tag: "ffmpeg-kit-dependencies",
        src: buildGradle,
        newSrc: newDependencies,
        anchor: /dependencies\s*\{/,
        offset: 1,
        comment: "//",
      }).contents;
    }

    const excludeConfig = `
    configurations.all {
        exclude group: 'com.arthenica', module: 'ffmpeg-kit-https'
        exclude group: 'com.arthenica', module: 'ffmpeg-kit-min'
        exclude group: 'com.arthenica', module: 'ffmpeg-kit-audio'
        exclude group: 'com.arthenica', module: 'ffmpeg-kit-video'
        exclude group: 'com.arthenica', module: 'ffmpeg-kit-full'
        exclude group: 'com.arthenica', module: 'ffmpeg-kit-full-gpl'
    }`;

    if (!buildGradle.includes("configurations.all")) {
      buildGradle = mergeContents({
        tag: "ffmpeg-kit-exclude-config",
        src: buildGradle,
        newSrc: excludeConfig,
        anchor: /android\s*\{/,
        offset: -1,
        comment: "//",
      }).contents;
    }

    if (!buildGradle.includes("def aarUrl =")) {
      // AAR is downloaded in root build.gradle during configuration (no Gradle task).
    }

    cfg.modResults.contents = buildGradle;
    return cfg;
  });

  config = withProjectBuildGradle(config, (cfg) => {
    let buildGradle = cfg.modResults.contents;

    const rootDownload = `import java.net.URL

def ffmpegKitAar = file("\${rootDir}/libs/ffmpeg-kit-full-gpl.aar")
def ffmpegKitAarUrl = '${androidUrl}'
if (!ffmpegKitAar.parentFile.exists()) {
    ffmpegKitAar.parentFile.mkdirs()
}
if (!ffmpegKitAar.exists()) {
    println "[ffmpeg-kit] Downloading AAR from \${ffmpegKitAarUrl}..."
    new URL(ffmpegKitAarUrl).withInputStream { i ->
        ffmpegKitAar.withOutputStream { it << i }
    }
    println "[ffmpeg-kit] AAR ready at \${ffmpegKitAar}"
}

`;
    if (!buildGradle.includes("ffmpegKitAarUrl")) {
      buildGradle = rootDownload + buildGradle;
    }

    buildGradle = buildGradle.replace(/^\s*ffmpegKitPackage\s*=\s*"full-gpl"\s*(\r?\n)?/m, "");

    const projectFlatDirLibsPath = "$rootDir/libs";
    const flatDirString = `        flatDir {\n            dirs "${projectFlatDirLibsPath}"\n        }`;
    const allProjectsRepositoriesRegex = /(allprojects\s*\{\s*repositories\s*\{)/;
    const existingFlatDirRegex = new RegExp(
      `allprojects\\s*\\{[\\s\\S]*?repositories\\s*\\{[\\s\\S]*?flatDir\\s*\\{[\\s\\S]*?dirs\\s*['"]${projectFlatDirLibsPath.replace(
        /[$.]/g,
        "\\$&",
      )}['"]`,
    );

    if (!buildGradle.match(existingFlatDirRegex)) {
      const match = buildGradle.match(allProjectsRepositoriesRegex);
      if (match) {
        const insertionPoint = match.index + match[0].length;
        buildGradle =
          buildGradle.substring(0, insertionPoint) +
          "\n" +
          flatDirString +
          buildGradle.substring(insertionPoint);
      }
    }

    cfg.modResults.contents = buildGradle;
    return cfg;
  });

  return config;
}

function withFfmpegKit(config, options = {}) {
  const iosUrl = options.iosUrl ?? DEFAULT_IOS_URL;
  const androidUrl = options.androidUrl ?? DEFAULT_ANDROID_URL;

  config = withGradleProperties(config, (mod) => {
    const entries = mod.modResults ?? [];
    const props = [
      ["android.lint.checkReleaseBuilds", "false"],
      ["android.lint.abortOnError", "false"],
    ];
    for (const [key, value] of props) {
      const existing = entries.find((e) => e.type === "property" && e.key === key);
      if (existing) existing.value = value;
      else entries.push({ type: "property", key, value });
    }
    mod.modResults = entries;
    return mod;
  });

  return withPlugins(config, [
    (c) => withFfmpegKitIos(c, { iosUrl }),
    (c) => withFfmpegKitAndroid(c, { androidUrl }),
  ]);
}

module.exports = withFfmpegKit;
