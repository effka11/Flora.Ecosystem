/**
 * Renders Flora app icons, splash, and the web tab icon from flora-logo-v1.svg.
 * Run: node scripts/render-flora-mobile-assets.mjs
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/** App canvas behind splash and the system bars. */
const FLORA_BG = "#0c0c0c";
/** Plate baked into flora-logo-v1.svg. plantCoverage measures the plant against this field. */
const LOGO_BG = "#0a0a0a";
/** Launcher icon field. Brand greenDark, not the logo plate. */
const ICON_BG = "#2c3527";
const LOGO_GREEN = "#a1cd87";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mobile = join(root, "apps", "Mobile");
const webPublic = join(root, "apps", "Web", "public");
/** Next file-convention favicons. These win the browser tab over public/. */
const webApp = join(root, "apps", "Web", "app");
/** Brand mark. Mobile and web only receive rendered copies. */
const assets = join(root, "packages", "flora-design", "assets");
const images = join(mobile, "assets", "images");
const logoSvg = join(assets, "flora-logo-v1.svg");

const LOGO_BG_RGB = hexRgb(LOGO_BG);
const LOGO_GREEN_RGB = hexRgb(LOGO_GREEN);

function hexRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** 0 on the logo field, 1 on the plant ink (linear along that segment). */
function plantCoverage(r, g, b) {
  const dr = LOGO_GREEN_RGB.r - LOGO_BG_RGB.r;
  const dg = LOGO_GREEN_RGB.g - LOGO_BG_RGB.g;
  const db = LOGO_GREEN_RGB.b - LOGO_BG_RGB.b;
  const t =
    ((r - LOGO_BG_RGB.r) * dr + (g - LOGO_BG_RGB.g) * dg + (b - LOGO_BG_RGB.b) * db) /
    (dr * dr + dg * dg + db * db);
  return Math.min(1, Math.max(0, t));
}

/**
 * Plant only, same placement as the logo. `color` recolors the ink (white
 * monochrome / notification); omitted keeps #a1cd87.
 */
async function renderMark(size, color) {
  const big = 1024;
  const svg = await readFile(logoSvg);
  const { data, info } = await sharp(svg, { density: 384 })
    .resize(big, big, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const target = color ? hexRgb(color) : null;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const coverage = plantCoverage(data[i], data[i + 1], data[i + 2]);
    const alpha = Math.round(coverage * 255);
    if (target) {
      out[i] = target.r;
      out[i + 1] = target.g;
      out[i + 2] = target.b;
    } else {
      out[i] = LOGO_GREEN_RGB.r;
      out[i + 1] = LOGO_GREEN_RGB.g;
      out[i + 2] = LOGO_GREEN_RGB.b;
    }
    out[i + 3] = alpha;
  }
  let pipeline = sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } });
  if (size !== big) {
    pipeline = pipeline.resize(size, size, { fit: "fill" });
  }
  return pipeline.png().toBuffer();
}

async function solidPng(outPath, size, hex) {
  const { r, g, b } = hexRgb(hex);
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: 255 } },
  })
    .png()
    .toFile(outPath);
}

async function splashPng(outPath, size) {
  const mark = await renderMark(size);
  const { r, g, b } = hexRgb(FLORA_BG);
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: 255 } },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toFile(outPath);
}

/**
 * Full-bleed white silhouette for Android status-bar / FCM small icon.
 * Tight crop — adaptive safe-zone padding must not ship into the tray.
 */
async function notificationIconPng(outPath, size) {
  const mono = await renderMark(1024, "#ffffff");
  const trimmed = await sharp(mono).trim().png().toBuffer();
  const margin = Math.max(1, Math.round(size * 0.04));
  const inner = size - 2 * margin;
  const leafBuf = await sharp(trimmed)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
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

/** Status-bar / tray small-icon densities (same as expo-notifications). */
const NOTIFICATION_DRAWABLE_PX = {
  "drawable-mdpi": 24,
  "drawable-hdpi": 36,
  "drawable-xhdpi": 48,
  "drawable-xxhdpi": 72,
  "drawable-xxxhdpi": 96,
};

async function solidWebp(outPath, size, hex) {
  const { r, g, b } = hexRgb(hex);
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
  const notifSource = join(images, "notification-icon.png");

  for (const [folder, size] of Object.entries(SPLASH_DRAWABLE_PX)) {
    const dir = join(resRoot, folder);
    if (!existsSync(dir)) continue;
    const { r, g, b } = hexRgb(FLORA_BG);
    await sharp(splashSource)
      .resize(size, size, { fit: "contain", background: { r, g, b, alpha: 255 } })
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
    await solidWebp(join(dir, "ic_launcher_background.webp"), size, ICON_BG);
  }

  // Always overwrite tray icons — release may skip expo prebuild when splash/version are fresh.
  for (const [folder, size] of Object.entries(NOTIFICATION_DRAWABLE_PX)) {
    const dir = join(resRoot, folder);
    if (!existsSync(dir)) continue;
    await sharp(notifSource)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(join(dir, "notification_icon.png"));
  }

  await syncLauncherIconBackground(resRoot);
  console.log("Synced Flora splash/icons into apps/Mobile/android_gen/");
}

/** Expo prebuild writes this once; a fresh android_gen skips prebuild, so keep the color here. */
async function syncLauncherIconBackground(resRoot) {
  const colorsPath = join(resRoot, "values", "colors.xml");
  if (!existsSync(colorsPath)) return;
  const xml = await readFile(colorsPath, "utf8");
  const next = xml.replace(
    /(<color name="iconBackground">)#[0-9A-Fa-f]{3,8}(<\/color>)/,
    `$1${ICON_BG}$2`,
  );
  if (next !== xml) await writeFile(colorsPath, next);
}

/** Longest side of the glyph, as a fraction of the tab icon. */
const TAB_MARK_FILL = 0.96;

async function markBounds() {
  const png = await renderMark(1024);
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] < 8) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function tabViewBox(bounds) {
  const w = bounds.maxX - bounds.minX + 1;
  const h = bounds.maxY - bounds.minY + 1;
  const side = Math.max(w, h) / TAB_MARK_FILL;
  const x = bounds.minX - (side - w) / 2;
  const y = bounds.minY - (side - h) / 2;
  const n = (v) => Math.round(v * 100) / 100;
  return `${n(x)} ${n(y)} ${n(side)} ${n(side)}`;
}

function withoutLogoPlate(source) {
  return source.replace(/\s*<rect\b[^>]*\/>/, "");
}

/**
 * Shrink the v1 composition about the canvas center. Do not re-center the
 * glyph: its offset in flora-logo-v1 is part of the mark.
 */
const APP_ICON_SCALE = 0.7;

async function renderScaledMark(size, color) {
  const mark = await renderMark(1024, color);
  const inner = Math.round(1024 * APP_ICON_SCALE);
  const glyph = await sharp(mark).resize(inner, inner, { fit: "fill" }).png().toBuffer();
  const offset = Math.round((1024 - inner) / 2);
  const canvas = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: glyph, left: offset, top: offset }])
    .png()
    .toBuffer();
  if (size === 1024) return canvas;
  return sharp(canvas).resize(size, size, { fit: "fill" }).png().toBuffer();
}

async function renderAppIcon(size) {
  const mark = await renderScaledMark(size);
  const { r, g, b } = hexRgb(ICON_BG);
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: 255 } },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toBuffer();
}

async function writePng(outPath, buffer) {
  await sharp(buffer).png().toFile(outPath);
}

async function main() {
  await mkdir(images, { recursive: true });

  const appIcon = await renderAppIcon(1024);
  await writePng(join(images, "icon.png"), appIcon);
  await writePng(join(images, "icon-dev.png"), appIcon);
  await writePng(join(images, "android-icon-foreground.png"), await renderScaledMark(1024));
  await writePng(join(images, "android-icon-monochrome.png"), await renderScaledMark(1024, "#ffffff"));
  await notificationIconPng(join(images, "notification-icon.png"), 192);
  await solidPng(join(images, "android-icon-background.png"), 1024, ICON_BG);
  await solidPng(join(images, "android-icon-background-dev.png"), 1024, ICON_BG);
  await splashPng(join(images, "splash-icon.png"), 1024);
  await splashPng(join(images, "favicon.png"), 48);

  // Corner chip uses the mark at its designed scale. The tab icon is the same
  // mark, cropped tighter so it reads at 16px.
  const logoSource = await readFile(logoSvg, "utf8");
  const bare = withoutLogoPlate(logoSource);
  await writeFile(join(webPublic, "logo-mark.svg"), bare);
  const tabSvg = bare.replace(/viewBox="[^"]+"/, `viewBox="${tabViewBox(await markBounds())}"`);
  await writeFile(join(webPublic, "icon.svg"), tabSvg);
  const tabSvgBuf = Buffer.from(tabSvg);
  const tabPng = (size) =>
    sharp(tabSvgBuf, { density: 384 }).resize(size, size, { fit: "fill" }).png().toBuffer();
  const favicon = await tabPng(32);
  const apple = await tabPng(180);
  await writePng(join(webPublic, "favicon-32.png"), favicon);
  await writePng(join(webPublic, "apple-icon.png"), apple);
  await writePng(join(webApp, "icon.png"), favicon);
  await writePng(join(webApp, "apple-icon.png"), apple);

  await syncAndroidGenRes();
  await syncLauncherIconBackground(join(mobile, "android", "app", "src", "main", "res"));

  console.log("Flora logo rendered for Mobile assets and Web tab icons.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
