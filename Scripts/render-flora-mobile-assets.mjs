/**
 * Renders Flora mobile icons + splash from SVG (replaces default Metro grid assets).
 * Run: node Scripts/render-flora-mobile-assets.mjs
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mobile = join(root, "Apps", "Mobile");
const assets = join(mobile, "assets");
const images = join(mobile, "assets", "images");

async function pngFromSvg(svgPath, outPath, size) {
  const svg = await readFile(svgPath);
  await sharp(svg, { density: 300 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);
}

async function solidPng(outPath, size, hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: 255 } },
  })
    .png()
    .toFile(outPath);
}

async function splashPng(outPath, size) {
  const leaf = await readFile(join(assets, "flora-mark-foreground.svg"));
  const leafSize = Math.round(size * 0.28);
  const leafBuf = await sharp(leaf, { density: 300 })
    .resize(leafSize, leafSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 12, g: 12, b: 12, alpha: 255 } },
  })
    .composite([{ input: leafBuf, gravity: "center" }])
    .png()
    .toFile(outPath);
}

const SPLASH_DRAWABLE_PX = {
  "drawable-mdpi": 288,
  "drawable-hdpi": 432,
  "drawable-xhdpi": 576,
  "drawable-xxhdpi": 864,
  "drawable-xxxhdpi": 1152,
};

const LAUNCHER_MIPMAP_PX = {
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};

const ADAPTIVE_MIPMAP_PX = {
  "mipmap-mdpi": 108,
  "mipmap-hdpi": 162,
  "mipmap-xhdpi": 216,
  "mipmap-xxhdpi": 324,
  "mipmap-xxxhdpi": 432,
};

async function solidWebp(outPath, size, hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: 255 } },
  })
    .webp()
    .toFile(outPath);
}

async function syncAndroidGenRes() {
  const resRoot = join(mobile, "android_gen", "app", "src", "main", "res");
  if (!existsSync(resRoot)) return;

  const splashSource = join(images, "splash-icon.png");
  const iconSource = join(images, "icon.png");
  const fgSource = join(images, "android-icon-foreground.png");
  const monoSource = join(images, "android-icon-monochrome.png");

  for (const [folder, size] of Object.entries(SPLASH_DRAWABLE_PX)) {
    const dir = join(resRoot, folder);
    if (!existsSync(dir)) continue;
    await sharp(splashSource)
      .resize(size, size, { fit: "contain", background: { r: 12, g: 12, b: 12, alpha: 255 } })
      .png()
      .toFile(join(dir, "splashscreen_logo.png"));
  }

  for (const [folder, size] of Object.entries(LAUNCHER_MIPMAP_PX)) {
    const dir = join(resRoot, folder);
    if (!existsSync(dir)) continue;
    const iconBuf = await sharp(iconSource).resize(size, size, { fit: "cover" }).webp().toBuffer();
    await sharp(iconBuf).toFile(join(dir, "ic_launcher.webp"));
    await sharp(iconBuf).toFile(join(dir, "ic_launcher_round.webp"));
  }

  for (const [folder, size] of Object.entries(ADAPTIVE_MIPMAP_PX)) {
    const dir = join(resRoot, folder);
    if (!existsSync(dir)) continue;
    await sharp(fgSource).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp().toFile(join(dir, "ic_launcher_foreground.webp"));
    await sharp(monoSource).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp().toFile(join(dir, "ic_launcher_monochrome.webp"));
    await solidWebp(join(dir, "ic_launcher_background.webp"), size, "#1a472a");
  }

  console.log("Synced Flora splash/icons into Apps/Mobile/android_gen/");
}

async function main() {
  await mkdir(images, { recursive: true });

  await pngFromSvg(join(assets, "flora-mark.svg"), join(images, "icon.png"), 1024);
  await pngFromSvg(join(assets, "flora-mark-foreground.svg"), join(images, "android-icon-foreground.png"), 1024);
  await pngFromSvg(join(assets, "flora-mark-monochrome.svg"), join(images, "android-icon-monochrome.png"), 1024);
  await solidPng(join(images, "android-icon-background.png"), 1024, "#0c0c0c");
  await splashPng(join(images, "splash-icon.png"), 1024);
  await splashPng(join(images, "favicon.png"), 48);

  await syncAndroidGenRes();

  console.log("Flora mobile assets rendered in Apps/Mobile/assets/images/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
