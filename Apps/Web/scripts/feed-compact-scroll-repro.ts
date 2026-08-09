/**
 * Chromium regression gate for feed compact-header scroll continuity.
 * Bundles scripts/feed-compact-scroll-harness.tsx (real useFeedCompactHeader + feed.module.css).
 *
 * Setup (once): npx playwright install chromium
 * Run: npm run feed:compact-scroll-repro
 *
 * Calibration (2026-08-09): Playwright `mouse.wheel` stayed green on the pre-fix
 * baseline that still used `flushSync` — this harness does **not** reproduce the
 * prod “freeze until mousemove” symptom. Treat PASS as “compact transition still
 * scrolls through threshold”, not as proof that removing flushSync fixed prod.
 * Prod confirmation remains a human residual on an authenticated feed.
 * Spacer/always-sticky (§4) — reopen if prod still freezes after the classList change.
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import CssModulesPlugin from "esbuild-css-modules-plugin";
import { chromium } from "playwright";

type HarnessApi = {
  scrollTop: () => number;
  threshold: () => number;
  hasCompactClass: () => boolean;
  isCompactState: () => boolean;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..");
const outDir = join(webRoot, ".tmp-feed-compact-scroll");
const outJs = join(outDir, "harness.js");
const outHtml = join(outDir, "index.html");

const WHEEL_STEPS = 24;
const WHEEL_DELTA = 80;
const PASS_MARGIN_PX = 40;
const STUCK_BAND_PX = 5;
/** Small wheels across the compact threshold — where Chromium tends to drop the gesture. */
const THRESHOLD_PROBE_STEPS = 40;
const THRESHOLD_PROBE_DELTA = 12;

async function bundle(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const result = await esbuild.build({
    absWorkingDir: webRoot,
    entryPoints: [join(__dirname, "feed-compact-scroll-harness.tsx")],
    bundle: true,
    format: "iife",
    outfile: outJs,
    jsx: "automatic",
    platform: "browser",
    target: ["chrome120"],
    metafile: true,
    plugins: [
      CssModulesPlugin({
        force: true,
        inject: true,
        localsConvention: "camelCaseOnly",
        pattern: "[name]_[hash]_[local]",
      }),
    ],
    loader: {
      ".tsx": "tsx",
      ".ts": "ts",
    },
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    logLevel: "silent",
    write: true,
  });
  if (result.errors.length) {
    throw new Error(result.errors.map((e) => e.text).join("\n"));
  }

  const js = readFileSync(outJs, "utf8");
  if (!js.includes("Compact") && !js.includes("compact")) {
    throw new Error("Bundle missing compact class strings from CSS module");
  }

  writeFileSync(
    outHtml,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>feed compact scroll harness</title>
    <style>
      html, body, #root {
        margin: 0;
        height: 100%;
        width: 100%;
        overflow: hidden;
        background: #000;
      }
      :root {
        --flora-grid-step: 15px;
        --flora-grid-step-fine: 5px;
        --flora-bg: #0a0a0a;
        --flora-white-template-rgb: 255, 255, 255;
        --flora-duration-6: 0.35s;
        --flora-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="./harness.js"></script>
  </body>
</html>
`
  );
}

async function runRepro(): Promise<void> {
  console.log(
    "[feed:compact-scroll-repro] calibration: pre-fix flushSync baseline was GREEN under Playwright wheel; gate ≠ prod-freeze proof"
  );
  await bundle();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(pathToFileURL(outHtml).href);
  await page.waitForFunction(() => {
    const w = window as Window & { __feedCompactHarness?: HarnessApi };
    return Boolean(w.__feedCompactHarness);
  });

  const scroll = page.locator("#central-scroll-feed");
  await scroll.waitFor();
  const box = await scroll.boundingBox();
  if (!box) throw new Error("scroll root has no box");

  // Position pointer once; subsequent wheels must not use mousemove.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  const before = await page.evaluate(() => {
    const h = (window as Window & { __feedCompactHarness?: HarnessApi }).__feedCompactHarness!;
    return { scrollTop: h.scrollTop(), threshold: h.threshold() };
  });

  // Probe A: jump just below threshold, then crawl across with small wheels (no mousemove).
  await page.evaluate(() => {
    const root = document.getElementById("central-scroll-feed");
    const h = (window as Window & { __feedCompactHarness?: HarnessApi }).__feedCompactHarness!;
    if (!root) return;
    root.scrollTop = Math.max(0, h.threshold() - 8);
  });
  await page.waitForTimeout(32);

  for (let i = 0; i < THRESHOLD_PROBE_STEPS; i++) {
    await page.mouse.wheel(0, THRESHOLD_PROBE_DELTA);
  }
  await page.waitForTimeout(150);

  const afterProbe = await page.evaluate(() => {
    const h = (window as Window & { __feedCompactHarness?: HarnessApi }).__feedCompactHarness!;
    return {
      scrollTop: h.scrollTop(),
      threshold: h.threshold(),
      hasCompactClass: h.hasCompactClass(),
      isCompactState: h.isCompactState(),
    };
  });

  const probeOk =
    afterProbe.scrollTop >= afterProbe.threshold + PASS_MARGIN_PX &&
    afterProbe.hasCompactClass === true &&
    Math.abs(afterProbe.scrollTop - afterProbe.threshold) > STUCK_BAND_PX;

  // Reset and Probe B: coarse wheels from top (full traverse).
  await page.evaluate(() => {
    const root = document.getElementById("central-scroll-feed");
    if (root) root.scrollTop = 0;
  });
  await page.waitForTimeout(32);

  for (let i = 0; i < WHEEL_STEPS; i++) {
    await page.mouse.wheel(0, WHEEL_DELTA);
  }
  await page.waitForTimeout(120);

  const afterDown = await page.evaluate(() => {
    const h = (window as Window & { __feedCompactHarness?: HarnessApi }).__feedCompactHarness!;
    return {
      scrollTop: h.scrollTop(),
      threshold: h.threshold(),
      hasCompactClass: h.hasCompactClass(),
      isCompactState: h.isCompactState(),
    };
  });

  const downOk =
    afterDown.scrollTop >= afterDown.threshold + PASS_MARGIN_PX &&
    afterDown.hasCompactClass === true &&
    Math.abs(afterDown.scrollTop - afterDown.threshold) > STUCK_BAND_PX;

  for (let i = 0; i < WHEEL_STEPS + 8; i++) {
    await page.mouse.wheel(0, -WHEEL_DELTA);
  }
  await page.waitForTimeout(120);

  const afterUp = await page.evaluate(() => {
    const h = (window as Window & { __feedCompactHarness?: HarnessApi }).__feedCompactHarness!;
    return {
      scrollTop: h.scrollTop(),
      threshold: h.threshold(),
      hasCompactClass: h.hasCompactClass(),
    };
  });

  const leaveLine = Math.max(0, afterUp.threshold - 15);
  const upOk = afterUp.scrollTop <= leaveLine && afterUp.hasCompactClass === false;

  await browser.close();

  const report = {
    before,
    afterProbe,
    afterDown,
    afterUp,
    probeOk,
    downOk,
    upOk,
  };

  if (!probeOk || !downOk || !upOk) {
    console.error("[feed:compact-scroll-repro] FAIL", JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log("[feed:compact-scroll-repro] PASS", JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  try {
    await runRepro();
  } finally {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

void main();
