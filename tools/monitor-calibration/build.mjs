#!/usr/bin/env node
/**
 * Generates index.html: a monitor setup page whose swatches are the canonical Flora colors.
 *
 * Sources of truth (never copied by hand):
 *   - packages/flora-client-core/src/display/floraThemeTokens.ts
 *   - apps/Web/app/globals.css (:root color variables, including color-mix derivations)
 *   - documents/design/color-reference.md (recognized brand colors)
 *
 * Usage: node tools/monitor-calibration/build.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const TOKENS_PATH = join(
  repoRoot,
  "packages/flora-client-core/src/display/floraThemeTokens.ts",
);
const CSS_PATH = join(repoRoot, "apps/Web/app/globals.css");
const DOC_PATH = join(repoRoot, "documents/design/color-reference.md");
const OUT_PATH = join(here, "index.html");

/** Doc rows are keyed by CSS variable, so renaming a display label never breaks the check. */
const BRAND_SOURCES = [
  { token: "bg", cssVar: "--flora-bg" },
  { token: "whiteTemplate", cssVar: "--flora-white-template" },
  { token: "greenLight", cssVar: "--flora-accent" },
  { token: "greenDark", cssVar: "--flora-accent-dark" },
];
const PIXEL_GRID =
  "repeating-linear-gradient(0deg,#fff 0 1px,transparent 1px 3px),repeating-linear-gradient(90deg,#fff 0 1px,transparent 1px 3px) #000";

function main() {
  const tokens = parseTokens(readFileSync(TOKENS_PATH, "utf8"));
  const cssVars = parseCssVars(readFileSync(CSS_PATH, "utf8"));
  const docBrands = parseBrandColors(readFileSync(DOC_PATH, "utf8"));

  if (tokens.length === 0)
    throw new Error("No tokens parsed from floraThemeTokens.ts");
  for (const source of BRAND_SOURCES) {
    if (!tokens.some((token) => token.key === source.token)) {
      throw new Error(
        `Brand token "${source.token}" is missing in FLORA_THEME_TOKENS`,
      );
    }
  }

  const cssColors = resolveCssColors(cssVars);
  const checks = crossCheck(tokens, cssColors);

  const brandMismatch = [];
  const brandMissing = [];
  for (const source of BRAND_SOURCES) {
    const tokenHex = tokens.find((token) => token.key === source.token).hex;
    if (!docBrands[source.token]) {
      brandMissing.push(source);
    } else if (docBrands[source.token] !== tokenHex) {
      brandMismatch.push({
        ...source,
        docHex: docBrands[source.token],
        tokenHex,
      });
    }
  }
  for (const source of brandMissing) {
    console.warn(
      `Brand color from color-reference.md is missing: ${source.cssVar} (${source.token})`,
    );
  }
  if (brandMismatch.length > 0) {
    for (const mismatch of brandMismatch) {
      console.error(
        `Brand mismatch for "${mismatch.token}": color-reference.md says ${mismatch.docHex}, tokens say ${mismatch.tokenHex}`,
      );
    }
    process.exit(1);
  }

  const bg = tokens.find((token) => token.key === "bg").hex;
  for (const token of tokens) {
    token.rgb = hexToRgb(token.hex);
    token.lab = rgbToLab(token.rgb);
    token.luminance = relativeLuminance(token.rgb);
    token.contrastOnBg = contrastRatio(token.hex, bg);
  }

  const html = renderPage({
    tokens,
    bg,
    checks,
    brandMismatch,
    brandDocCount: BRAND_SOURCES.filter((source) => docBrands[source.token])
      .length,
    brandDocTotal: BRAND_SOURCES.length,
  });
  writeFileSync(OUT_PATH, html, "utf8");

  const mismatches = checks.filter((check) => check.status === "mismatch");
  const tsOnly = checks.filter((check) => check.status === "ts-only");
  console.log(
    `tokens: ${tokens.length}, css colors resolved: ${cssColors.size}`,
  );
  console.log(
    `cross-check: ${checks.length - mismatches.length - tsOnly.length} ok, ${mismatches.length} mismatch, ${tsOnly.length} ts-only`,
  );
  for (const check of mismatches) {
    console.log(
      `  MISMATCH ${check.token}: tokens ${check.tokenHex} vs ${check.cssVar} ${check.cssHex}`,
    );
  }
  console.log(
    `brand colors verified against color-reference.md: ${
      BRAND_SOURCES.filter((source) => docBrands[source.token]).length
    }/${BRAND_SOURCES.length}`,
  );
  console.log(`wrote ${OUT_PATH}`);
}

/** Parses `key: "#rrggbb"` entries of FLORA_THEME_TOKENS, keeping the preceding comment. */
function parseTokens(source) {
  const tokens = [];
  let note = "";
  let inBlockComment = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) {
        note = pushNote(note, line);
      } else {
        note = pushNote(note, line.slice(0, end));
        inBlockComment = false;
      }
      continue;
    }
    if (line.startsWith("/*")) {
      const body = line.replace(/^\/\*\*?/, "");
      const end = body.indexOf("*/");
      if (end === -1) {
        note = pushNote(note, body);
        inBlockComment = true;
      } else {
        note = pushNote(note, body.slice(0, end));
      }
      continue;
    }
    if (line.startsWith("//")) {
      note = pushNote(note, line.slice(2));
      continue;
    }

    const match = /^([A-Za-z0-9]+):\s*"(#[0-9a-fA-F]{6})",?$/.exec(line);
    if (match) {
      tokens.push({ key: match[1], hex: match[2].toLowerCase(), note });
      note = "";
    }
  }
  return tokens;
}

function pushNote(current, addition) {
  const cleaned = addition.replace(/\*\/$/, "").replace(/^\*+/, "").trim();
  if (!cleaned) return current;
  return current ? `${current} ${cleaned}` : cleaned;
}

/** Parses color declarations of the first :root block. */
function parseCssVars(source) {
  const start = source.search(/:root\s*\{/);
  if (start === -1) throw new Error(":root block not found in globals.css");
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  if (close === -1) throw new Error("Unterminated :root block in globals.css");

  const vars = new Map();
  for (const line of source.slice(open + 1, close).split(/\r?\n/)) {
    const match = /^\s*(--flora-[a-z0-9-]+)\s*:\s*(.+?);\s*$/.exec(line);
    if (match) vars.set(match[1], match[2].trim());
  }
  return vars;
}

/** Resolves hex / var() / two-color srgb color-mix() chains into hex. */
function resolveCssColors(vars) {
  const resolved = new Map();
  const resolving = new Set();

  const resolveValue = (value) => {
    const text = value.trim();

    if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();

    const varOnly = /^var\((--flora-[a-z0-9-]+)\)$/.exec(text);
    if (varOnly) return resolveVar(varOnly[1]);

    const mix =
      /^color-mix\(\s*in srgb\s*,\s*(var\(--flora-[a-z0-9-]+\)|#[0-9a-fA-F]{6})\s+([\d.]+)%\s*,\s*(var\(--flora-[a-z0-9-]+\)|#[0-9a-fA-F]{6})\s+([\d.]+)%\s*\)$/.exec(
        text,
      );
    if (mix) {
      const first = resolveOperand(mix[1]);
      const second = resolveOperand(mix[3]);
      if (!first || !second) return null;
      return mixHex(first, Number(mix[2]), second, Number(mix[4]));
    }
    return null;
  };

  const resolveOperand = (operand) => {
    const varName = /^var\((--flora-[a-z0-9-]+)\)$/.exec(operand);
    return varName ? resolveVar(varName[1]) : operand.toLowerCase();
  };

  const resolveVar = (name) => {
    if (resolved.has(name)) return resolved.get(name);
    if (resolving.has(name)) return null;
    const raw = vars.get(name);
    if (!raw) return null;
    resolving.add(name);
    const hex = resolveValue(raw);
    resolving.delete(name);
    if (hex) resolved.set(name, hex);
    return hex;
  };

  for (const name of vars.keys()) resolveVar(name);
  return resolved;
}

function crossCheck(tokens, cssColors) {
  return tokens.map((token) => {
    const cssVar = `--flora-${camelToKebab(token.key)}`;
    const cssHex = cssColors.get(cssVar);
    if (!cssHex) {
      return {
        token: token.key,
        cssVar,
        status: "ts-only",
        tokenHex: token.hex,
      };
    }
    const diff = maxChannelDiff(token.hex, cssHex);
    return {
      token: token.key,
      cssVar,
      status: diff <= 1 ? "ok" : "mismatch",
      tokenHex: token.hex,
      cssHex,
      diff,
    };
  });
}

/** Reads `| **brand** | `--var` | `#hex` |` rows of the brand table. */
function parseBrandColors(source) {
  const brands = {};
  for (const { token, cssVar } of BRAND_SOURCES) {
    const pattern = new RegExp(
      "\\|\\s*[^|]*\\|\\s*`" +
        escapeRegExp(cssVar) +
        "`\\s*\\|\\s*`(#[0-9a-fA-F]{6})`",
    );
    const match = pattern.exec(source);
    if (match) brands[token] = match[1].toLowerCase();
  }
  return brands;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderPage(state) {
  const { tokens, bg, checks, brandDocCount, brandDocTotal } = state;
  const byKey = new Map(tokens.map((token) => [token.key, token]));
  const ui = {
    bg,
    fg: byKey.get("whiteTemplate").hex,
    muted: byKey.get("gray").hex,
    accent: byKey.get("greenLight").hex,
    signal: byKey.get("signal").hex,
    signalSolid: byKey.get("signalSolid").hex,
    surface: byKey.get("reserveSurfaceThem").hex,
    line: byKey.get("reservePopoverDivider").hex,
    bubbleBg: byKey.get("messagesBubbleThemBg").hex,
    bubbleText: byKey.get("messagesBubbleThemText").hex,
    bubbleTime: byKey.get("messagesBubbleThemTime").hex,
  };
  const sorted = [...tokens].sort((a, b) => a.lab[0] - b.lab[0]);
  const byHex = new Map();
  for (const token of tokens) {
    const group = byHex.get(token.hex) ?? [];
    group.push(token.key);
    byHex.set(token.hex, group);
  }
  const identicalGroups = [...byHex.entries()].filter(
    ([, keys]) => keys.length > 1,
  );

  const darkLadder = sorted.filter((token) => token.lab[0] < 30);
  const mismatches = checks.filter((check) => check.status === "mismatch");
  const tsOnly = checks.filter((check) => check.status === "ts-only");

  const generatedAt = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  }).format(new Date());

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flora — проверка монитора по токенам</title>
<style>
  :root {
    --bg: ${ui.bg};
    --fg: ${ui.fg};
    --muted: ${ui.muted};
    --accent: ${ui.accent};
    --signal: ${ui.signal};
    --signal-solid: ${ui.signalSolid};
    --surface: ${ui.surface};
    --line: ${ui.line};
    --bubble-bg: ${ui.bubbleBg};
    --bubble-text: ${ui.bubbleText};
    --bubble-time: ${ui.bubbleTime};
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 400 15px/1.6 ui-sans-serif, system-ui, "Segoe UI", Roboto, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); }
  code, .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
  header.top { padding: 40px 28px 24px; border-bottom: 1px solid var(--line); }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 26px; line-height: 1.25; margin: 0 0 8px; font-weight: 500; }
  h2 { font-size: 20px; margin: 0 0 6px; font-weight: 500; }
  h3 { font-size: 15px; margin: 22px 0 8px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); }
  p { margin: 0 0 12px; }
  .lead { color: var(--muted); max-width: 78ch; }
  .warn { color: var(--signal); }
  .ok { color: var(--accent); }
  .pill {
    display: inline-block; padding: 2px 8px; border: 1px solid var(--line);
    border-radius: 999px; font-size: 12px; color: var(--muted); margin: 0 6px 6px 0;
  }
  nav.toc {
    position: sticky; top: 0; z-index: 20; background: var(--bg);
    border-bottom: 1px solid var(--line); padding: 10px 28px; overflow-x: auto; white-space: nowrap;
  }
  nav.toc a { color: var(--muted); text-decoration: none; margin-right: 18px; font-size: 13px; }
  nav.toc a:hover { color: var(--fg); }
  main { padding: 0 28px 80px; }
  section { padding: 36px 0 8px; border-bottom: 1px solid var(--line); }
  section:last-of-type { border-bottom: 0; }
  .cols { display: grid; grid-template-columns: 1.15fr .85fr; gap: 24px; }
  @media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }
  .card { background: var(--surface); border: 1px solid var(--line); padding: 16px; }
  .checklist { margin: 0; padding-left: 18px; }
  .checklist li { margin-bottom: 6px; }
  .steps { display: grid; grid-auto-flow: column; gap: 4px; }
  .step { text-align: center; font-size: 11px; color: var(--muted); }
  .step i { display: block; height: 120px; border: 0; border-radius: 0; }
  .step b { display: block; font-weight: 400; margin-top: 6px; font-family: ui-monospace, Consolas, monospace; }
  .patchRow { display: flex; gap: 0; }
  .patch { flex: 1 1 0; height: 150px; border: 0; border-radius: 0; cursor: pointer; }
  .gammaRow { display: flex; gap: 10px; align-items: stretch; flex-wrap: wrap; }
  .gammaRow .checker {
    width: 170px; height: 170px; flex: 0 0 auto;
    background-image: repeating-conic-gradient(#fff 0 25%, #000 0 50%);
    background-size: 2px 2px; background-position: 0 0;
  }
  .gammaGroup { flex: 1 1 0; min-width: 130px; }
  .gammaPatch {
    height: 170px; display: flex; flex-direction: column; justify-content: flex-end;
    align-items: center; gap: 2px; padding: 8px; cursor: pointer;
  }
  .gammaPatch b { font-size: 13px; font-weight: 600; color: #000; background: rgba(250,250,250,.75); padding: 0 6px; }
  .gammaPatch code { font-size: 11px; color: #000; background: rgba(250,250,250,.75); padding: 0 6px; }
  .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .swatch {
    display: grid; grid-template-columns: 54px 1fr; gap: 12px; align-items: center;
    text-align: left; padding: 8px; background: var(--surface); border: 1px solid var(--line);
    color: inherit; font: inherit; cursor: pointer;
  }
  .swatch:hover { border-color: var(--muted); }
  .swatch .chip { width: 54px; height: 54px; border-radius: 0; display: block; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fg) 18%, transparent); }
  .swatch .name { font-size: 13px; display: block; overflow-wrap: anywhere; }
  .swatch code { font-size: 12px; color: var(--fg); }
  .swatch .stats { font-size: 11px; color: var(--muted); display: block; }
  .ladder { display: grid; grid-template-columns: 62% 1fr; gap: 0 16px; align-items: stretch; }
  .ladder .bar { min-height: 34px; border-radius: 0; cursor: pointer; }
  .ladder .label { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 10px; font-size: 12px; border-bottom: 1px solid #000; }
  .ladder .label code { color: var(--fg); }
  .ladder .label span { color: var(--muted); }
  .gradient { height: 90px; border: 0; border-radius: 0; }
  .rough {
    height: 34px; border: 0; border-radius: 0; background-color: #000;
    background-image:
      repeating-linear-gradient(0deg, #fff 0 1px, transparent 1px 3px),
      repeating-linear-gradient(90deg, #fff 0 1px, transparent 1px 3px);
  }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td.ratio { font-family: ui-monospace, Consolas, monospace; white-space: nowrap; }
  .badge { font-size: 11px; padding: 1px 6px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .badge.pass { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, var(--bg)); }
  .badge.fail { color: var(--signal); border-color: color-mix(in srgb, var(--signal) 45%, var(--bg)); }
  .textSample { background: var(--bg); padding: 16px; border: 1px solid var(--line); }
  .textSample .s15 { font-size: 15px; font-weight: 300; letter-spacing: .45px; line-height: 1.7; }
  .textSample .s13 { font-size: 13px; color: var(--muted); }
  .bubble { background: var(--bubble-bg); color: var(--bubble-text); padding: 10px 15px; border-radius: 18px; font-size: 15px; line-height: 25px; max-width: 420px; }
  .bubble time { display: block; color: var(--bubble-time); font-size: 12px; }
  .note { font-size: 13px; color: var(--muted); }
  .note strong { color: var(--fg); font-weight: 500; }
  .fs {
    position: fixed; inset: 0; z-index: 100; cursor: pointer;
  }
  .fs::after {
    content: "Esc или клик — выйти"; position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
    font-size: 12px; color: var(--muted); background: color-mix(in srgb, var(--bg) 82%, transparent); padding: 4px 10px;
  }
  .fs.checker {
    background-image: repeating-conic-gradient(#fff 0 25%, #000 0 50%) !important;
    background-size: 2px 2px !important;
  }
  footer { padding: 28px; color: var(--muted); font-size: 12px; }
  kbd { border: 1px solid var(--line); padding: 0 5px; font-size: 11px; }
</style>
</head>
<body>
<header class="top"><div class="wrap">
  <h1>Проверка монитора по токенам Flora</h1>
  <p class="lead">
    Страница показывает <strong>канонические sRGB-заливки</strong> из репозитория и тесты, по которым монитор приводят
    к условиям, зафиксированным в <code>documents/design/color-reference.md</code>: SDR, sRGB, γ 2.2, 6500 K, Full range,
    масштаб 100 %, чётные пиксели.
  </p>
  <p class="note">
    Страница <strong>не измеряет</strong> панель: колориметра здесь нет. Она даёт однозначные ориентиры «видно / не видно»
    и эталонные образцы токенов, чтобы поймать чёрный клиппинг, выбитые света, неверную гамму, цветной оттенок серого
    и пост-обработку. Абсолютная точность (ΔE) — только аппаратный калибратор + ICC-профиль.
  </p>
  <div>
    <span class="pill">токенов: ${tokens.length}</span>
    <span class="pill">бренд-цветов сверено с color-reference.md: ${brandDocCount}/${brandDocTotal}</span>
    <span class="pill">CSS↔TS расхождений: ${mismatches.length}</span>
    <span class="pill">сгенерировано: ${generatedAt}</span>
  </div>
</div></header>

<nav class="toc"><div class="wrap">
  <a href="#setup">1. Окружение</a>
  <a href="#black">2. Чёрный</a>
  <a href="#white">3. Белый</a>
  <a href="#gamma">4. Гамма</a>
  <a href="#neutral">5. Нейтраль</a>
  <a href="#darks">6. Тёмная лестница</a>
  <a href="#ramps">7. Градиенты</a>
  <a href="#tokens">8. Токены</a>
  <a href="#contrast">9. Контраст</a>
  <a href="#text">10. Текст и пиксели</a>
</div></nav>

<main class="wrap">

${renderSetup()}

${renderBlack()}

${renderWhite()}

${renderGamma()}

${renderNeutral(ui)}

${renderDarkLadder(darkLadder, bg)}

${renderRamps(ui)}

${renderTokens(sorted, { mismatches, tsOnly, identicalGroups })}

${renderContrast(tokens)}

${renderTextAndPixels(tokens, ui)}

</main>

<footer class="wrap">
  Источники: <code>packages/flora-client-core/src/display/floraThemeTokens.ts</code>,
  <code>apps/Web/app/globals.css</code>, <code>documents/design/color-reference.md</code>.
  Файл сгенерирован: <code>node tools/monitor-calibration/build.mjs</code>. Руками не править.
</footer>

<div id="fs" class="fs" hidden></div>
<script>
(function () {
  var overlay = document.getElementById('fs');

  function closeOverlay() {
    overlay.hidden = true;
    overlay.className = 'fs';
    overlay.style.background = '';
  }

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-fs], [data-fs-pattern]');
    if (!target || target === overlay) return;
    var value = target.getAttribute('data-fs');
    var pattern = target.getAttribute('data-fs-pattern');
    overlay.className = pattern === 'checker' ? 'fs checker' : 'fs';
    overlay.style.background = pattern ? '' : value;
    overlay.hidden = false;
  });

  overlay.addEventListener('click', closeOverlay);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !overlay.hidden) closeOverlay();
  });
})();
</script>
</body>
</html>
`;
}

function renderSetup() {
  return `<section id="setup">
  <h2>1. Окружение: сначала выключить всё, что «улучшает» картинку</h2>
  <p class="lead">Порядок важен: пока включены динамические режимы, любые тесты ниже врут. Калибровать нужно на прогретом мониторе (30 минут) в постоянном освещении.</p>
  <div class="cols">
    <div class="card">
      <h3>Монитор и система</h3>
      <ol class="checklist">
        <li><strong>Разрешение</strong> 1920 × 1080, <strong>масштаб 100 %</strong>, частота 60 Гц — тесты рассчитаны на 1 CSS px = 1 физический px.</li>
        <li><strong>HDR выключен</strong>: Параметры → Система → Дисплей → HDR. Контент sRGB в HDR-режиме Windows выглядит промытым.</li>
        <li><strong>Ночной свет выключен</strong>: там же, «Ночной свет» → Выкл.</li>
        <li><strong>Профиль</strong>: <code>colorcpl.exe</code> → устройство → sRGB IEC61966-2.1 (или профиль производителя) по умолчанию.</li>
        <li><strong>NVIDIA</strong>: формат цвета RGB, глубина 8 bpc, динамический диапазон <strong>Full</strong>. Digital Vibrance и любые «улучшения» — в ноль, «Other applications control color settings».</li>
      </ol>
      <h3>Меню монитора (OSD)</h3>
      <ol class="checklist">
        <li>SmartImage — <strong>Standard</strong> (или <strong>sRGB</strong>, если пункт есть). Не Game / Movie / Photo.</li>
        <li>SmartContrast — <strong>Off</strong>, SmartResponse — Off, Over Scan — Off, LowBlue / EasyRead — Off, Pixel Orbiting — Off.</li>
        <li>Gamma — <strong>2.2</strong>. Color Temperature — <strong>6500 K</strong>. User Define (RGB-усиление) не трогать, пока нет измерений.</li>
        <li>Contrast — 50 (заводской). <strong>Brightness</strong> — одно фиксированное комфортное значение; в тёмной комнате это обычно 30–50. Записать значение и не менять.</li>
        <li>Sharpness — заводское (50). Выше — гало и «звон» на белом тексте.</li>
      </ol>
      <p class="note"><strong>Освещение:</strong> нейтральный белый свет ~6500 K, без прямого солнца и лампы в экране; яркость вокруг — примерно как у белого на экране.</p>
    </div>
    <div class="card">
      <h3>Порядок настройки</h3>
      <ol class="checklist">
        <li>Сброс OSD на заводские (Reset).</li>
        <li>SmartImage → Standard / sRGB; SmartContrast → Off.</li>
        <li>Brightness по тесту <a href="#black">чёрного</a>: 16 должно едва отличаться от 0, 0 остаётся чёрным.</li>
        <li>Contrast по тесту <a href="#white">белого</a>: 255 белый, 250 ещё отличим.</li>
        <li>Gamma по <a href="#gamma">шахматке</a> → 2.2.</li>
        <li>Нейтраль по <a href="#neutral">серому клину</a> → 6500 K, без зелени и мадженты.</li>
        <li>Проверить <a href="#darks">тёмную лестницу</a> и <a href="#ramps">градиенты</a>.</li>
        <li>Записать итоговые значения OSD в журнал в <code>tools/monitor-calibration/README.md</code>.</li>
      </ol>
      <p class="note"><strong>Почему не крутить RGB-усиление наугад:</strong> на панели без калибратора это легко даёт «серый с оттенком» и потерянные ступени в тенях. Заводской пресет 6500 K + γ 2.2 предсказуемее ручной подстройки.</p>
    </div>
  </div>
</section>`;
}

function renderBlack() {
  const steps = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16];
  return `<section id="black">
  <h2>2. Чёрный: яркость и диапазон</h2>
  <p class="lead">Плитки 0–16 на чистом чёрном. Клик по плитке — заливка на весь экран.</p>
  <div class="card">
    <div class="steps">
      ${steps
        .map((value) => {
          const hex = grayHex(value);
          return `<div class="step"><i data-fs="${hex}" style="background:${hex}"></i><b>${value}</b></div>`;
        })
        .join("")}
    </div>
    <div style="height:10px"></div>
    <p class="note"><strong>Норма:</strong> 0 — абсолютно чёрный, 1–2 неотличимы от него, 3–4 едва угадываются, 8 и выше видны уверенно.
    <br><strong>Схлопнулись 0–6:</strong> чёрный клиппинг — поднимайте Brightness или включите Full range в NVIDIA. <strong>0 выглядит серым:</strong> яркость завышена — опускайте.</p>
  </div>
</section>`;
}

function renderWhite() {
  const steps = [239, 241, 243, 245, 247, 249, 250, 251, 252, 253, 254, 255];
  return `<section id="white">
  <h2>3. Белый: контраст и клиппинг</h2>
  <p class="lead">Света не должны слипаться: 250–255 обязаны различаться, 255 остаётся белым без «выгорания».</p>
  <div class="card">
    <div class="steps">
      ${steps
        .map((value) => {
          const hex = grayHex(value);
          return `<div class="step"><i data-fs="${hex}" style="background:${hex}"></i><b>${value}</b></div>`;
        })
        .join("")}
    </div>
    <div style="height:10px"></div>
    <p class="note"><strong>Норма:</strong> 255 — чистый белый; 250, 252 ещё различимы; ступени 1–2 видны как мягкий переход.
    <br><strong>Всё от 239 — белое:</strong> Contrast завышен или включён динамический контраст. <strong>255 выглядит серым:</strong> Contrast/Brightness занижены либо включён ограниченный диапазон.</p>
  </div>
</section>`;
}

function renderGamma() {
  const gammas = [1.8, 2.0, 2.2, 2.4, 2.6];
  return `<section id="gamma">
  <h2>4. Гамма: шахматка против серых</h2>
  <p class="lead">Шахматка из чёрных и белых пикселей в среднем даёт 50 % линейной яркости. Плашка, которая сливается с шахматкой, показывает фактическую гамму монитора. Смотреть с расстояния 1–1,5 м или прищурившись.</p>
  <div class="card">
    <div class="gammaRow">
      <div class="checker" data-fs-pattern="checker" title="50 % линейной яркости"></div>
      ${gammas
        .map((gamma) => {
          const value = Math.round(255 * Math.pow(0.5, 1 / gamma));
          const hex = grayHex(value);
          return `<div class="gammaGroup">
            <div class="gammaPatch" data-fs="${hex}" style="background:${hex}"><b>γ ${gamma}</b><code>${value}</code></div>
          </div>`;
        })
        .join("")}
    </div>
    <div style="height:10px"></div>
    <p class="note"><strong>Норма:</strong> с шахматкой сливается плашка <strong>γ 2.2</strong> (код 186). Сливается 2.4 — монитор темнит середину, опустите Gamma в OSD на шаг. Сливается 2.0 — пересвет, поднимите Gamma. Правильный пресет — 2.2, без «поправок на глаз» через RGB.</p>
  </div>
</section>`;
}

function renderNeutral(ui) {
  const wedge = Array.from({ length: 33 }, (_, index) =>
    grayHex(Math.round((index * 255) / 32)),
  );
  return `<section id="neutral">
  <h2>5. Нейтраль: белая точка и оттенок серого</h2>
  <p class="lead">В клине все каналы равны (R = G = B). Любой цветной оттенок на клине — это монитор, а не токены.</p>
  <div class="card">
    <div class="patchRow">
      ${wedge
        .map(
          (hex) =>
            `<div class="patch" data-fs="${hex}" style="background:${hex};height:120px" title="${hex}"></div>`,
        )
        .join("")}
    </div>
    <div style="height:8px"></div>
    <div class="patchRow">
      <div class="patch" data-fs="#808080" style="background:#808080;height:90px" title="нейтральный эталон 50%"></div>
      <div class="patch" data-fs="${ui.fg}" style="background:${ui.fg};height:90px" title="whiteTemplate"></div>
      <div class="patch" data-fs="${ui.bg}" style="background:${ui.bg};height:90px" title="bg"></div>
      <div class="patch" data-fs="${ui.accent}" style="background:${ui.accent};height:90px" title="accent"></div>
      <div class="patch" data-fs="${ui.signal}" style="background:${ui.signal};height:90px" title="signal"></div>
      <div class="patch" data-fs="${ui.signalSolid}" style="background:${ui.signalSolid};height:90px" title="signal-solid"></div>
    </div>
    <div style="height:10px"></div>
    <p class="note"><strong>Норма:</strong> клин нейтральный от теней до светов, белый — белый, без розового/зелёного/синего ухода. Ниже — нейтральный эталон 50 % и фактические бренд-заливки <code>whiteTemplate</code>, <code>bg</code>, <code>accent</code>, <code>signal</code>, <code>signal-solid</code>.
    <br><strong>Серый уходит в зелень или маджету:</strong> смените пресет 6500 K / sRGB, не «лечите» RGB-слайдерами. <strong>Белый кажется тёплым:</strong> проверьте, что Night Light и LowBlue выключены, затем верните пресет цвета.</p>
  </div>
</section>`;
}

function renderDarkLadder(ladder, bg) {
  const steps = [];
  for (const token of ladder) {
    const last = steps[steps.length - 1];
    if (last && last.hex === token.hex) last.keys.push(token.key);
    else steps.push({ hex: token.hex, keys: [token.key] });
  }

  const rows = steps
    .map((step, index) => {
      const delta =
        index === 0 ? null : deltaE76(step.hex, steps[index - 1].hex);
      const gapLabel =
        delta === null ? "" : `<span>ΔE ${delta.toFixed(1)}</span>`;
      return `<div class="bar" data-fs="${step.hex}" style="background:${step.hex}" title="${escapeHtml(step.keys.join(", "))}"></div>
      <div class="label"><code>${step.hex}</code><span>${step.keys.join(" · ")}</span>${gapLabel}</div>`;
    })
    .join("");

  return `<section id="darks">
  <h2>6. Тёмная лестница токенов</h2>
  <p class="lead">Flora живёт в тенях: фон <code>${bg}</code>, подложки и пузыри отличаются на единицы sRGB. Здесь проверяется, что монитор не схлопывает эти ступени и не рисует лишних границ. ΔE — расстояние в Lab (CIE76) до предыдущей ступени: значения ниже 1 глазом почти не различаются и задуманы как «одна поверхность».</p>
  <div class="card">
    <div class="ladder">${rows}</div>
    <div style="height:10px"></div>
    <p class="note"><strong>Норма:</strong> каждая полоса читается как отдельная ступень там, где ΔE заметно больше 1; порядок ровный, без «провала» и без резкого скачка.
    <br><strong>Полосы слиплись в 2–3 блока:</strong> поднят чёрный или включён динамический контраст. <strong>Между полосами видны светлые линии:</strong> включён Over Scan / резкость / локальное затемнение — выключить.</p>
  </div>
</section>`;
}

function renderRamps(ui) {
  return `<section id="ramps">
  <h2>7. Градиенты: бандинг и дизеринг</h2>
  <p class="lead">Три перехода: полный серый, тёмный участок палитры (0–48) и основной акцент бренда. Клик — на весь экран.</p>
  <div class="card">
    <h3>Серый 0 → 255</h3>
    <div class="gradient" data-fs="linear-gradient(90deg,#000,#fff)" style="background:linear-gradient(90deg,#000,#fff)"></div>
    <h3>Тени 0 → 48 (рабочий диапазон Flora)</h3>
    <div class="gradient" data-fs="linear-gradient(90deg,#000,#303030)" style="background:linear-gradient(90deg,#000,#303030)"></div>
    <h3>Акцент: ${ui.bg} → ${ui.accent}</h3>
    <div class="gradient" data-fs="linear-gradient(90deg,${ui.bg},${ui.accent})" style="background:linear-gradient(90deg,${ui.bg},${ui.accent})"></div>
    <h3>1 px линии (резкость / масштаб)</h3>
    <div class="rough" data-fs="${PIXEL_GRID}"></div>
    <div style="height:10px"></div>
    <p class="note"><strong>Норма:</strong> переходы гладкие, без вертикальных «ступеней» и цветных полос на тёмном участке. Полосатость на 0–48 при плавном 0–255 — типичный признак 6-bit + FRC и включённой пост-обработки.
    <br><strong>Ступени на тенистом градиенте:</strong> отключите SmartContrast / «улучшение изображения» в OSD, проверьте 8 bpc в NVIDIA. <strong>Цветные полосы:</strong> смените пресет цвета (не User Define).</p>
  </div>
</section>`;
}

function renderTokens(sorted, { mismatches, tsOnly, identicalGroups }) {
  const cards = sorted
    .map((token) => {
      const mismatch = mismatches.find((check) => check.token === token.key);
      const status = mismatch
        ? `<span class="stats warn">CSS: ${mismatch.cssHex} (расхождение)</span>`
        : "";
      return `<button class="swatch" data-fs="${token.hex}" title="${escapeHtml(token.note || token.key)}">
        <span class="chip" style="background:${token.hex}"></span>
        <span>
          <span class="name">${token.key}</span>
          <code>${token.hex}</code>
          <span class="stats">L* ${token.lab[0].toFixed(1)} · ${token.contrastOnBg.toFixed(2)}:1 к фону</span>
          ${status}
        </span>
      </button>`;
    })
    .join("");

  const identical =
    identicalGroups.length === 0
      ? ""
      : `<p class="note"><strong>Одинаковые значения (задумано):</strong> ${identicalGroups
          .map(
            ([hex, keys]) =>
              `<code>${hex}</code> — ${keys.map((key) => `<code>${key}</code>`).join(", ")}`,
          )
          .join("; ")}.</p>`;

  const tsOnlyNote =
    tsOnly.length === 0
      ? ""
      : `<p class="note"><strong>Только в TS (нет одноимённой переменной в <code>:root</code>):</strong> ${tsOnly
          .map((check) => `<code>${check.cssVar}</code>`)
          .join(", ")}. Значение взято из <code>FLORA_THEME_TOKENS</code>.</p>`;

  return `<section id="tokens">
  <h2>8. Токены: эталонные sRGB-заливки</h2>
  <p class="lead">Все ${sorted.length} цветовых токенов, отсортированы от тёмных к светлым. Клик — заливка на весь экран; сравнивайте с соседними токенами и с тем, что видно в приложении.</p>
  <div class="swatches">${cards}</div>
  <div style="height:12px"></div>
  ${identical}
  ${tsOnlyNote}
  <p class="note">Контраст указан по WCAG к основному фону. Это расчёт по sRGB, монитор на него не влияет — влияет только на то, различимы ли ступени глазами.</p>
</section>`;
}

function renderContrast(tokens) {
  const byKey = new Map(tokens.map((token) => [token.key, token]));
  const pairs = [
    ["whiteTemplate", "bg", "основной текст", "text"],
    ["gray", "bg", "приглушённый текст", "text"],
    ["greenLight", "bg", "акцент, ссылки", "text"],
    ["signal", "bg", "сигнал, лайк", "text"],
    ["signalSolid", "bg", "диагональ блокировки", "line"],
    ["textOnBubble", "greenBubble", "свой пузырь", "text"],
    ["messagesBubbleThemText", "messagesBubbleThemBg", "чужой пузырь", "text"],
    [
      "messagesBubbleThemTime",
      "messagesBubbleThemBg",
      "время в пузыре",
      "text",
    ],
    ["whiteTemplate", "reserveHoverSurface", "текст на подложке", "text"],
    ["greenLight", "greenDark", "акцент на greenDark", "text"],
    ["gray", "reserveSubstrateTemplate", "иконки на подложке", "text"],
    ["grayDivider", "bg", "разделитель", "line"],
  ];

  const rows = pairs
    .filter(
      ([foreground, background]) =>
        byKey.has(foreground) && byKey.has(background),
    )
    .map(([foreground, background, role, kind]) => {
      const ratio = contrastRatio(
        byKey.get(foreground).hex,
        byKey.get(background).hex,
      );
      const badge =
        kind === "line"
          ? `<span class="badge">не текст</span>`
          : ratio >= 7
            ? `<span class="badge pass">AAA</span>`
            : ratio >= 4.5
              ? `<span class="badge pass">AA</span>`
              : ratio >= 3
                ? `<span class="badge">только крупный</span>`
                : `<span class="badge fail">ниже 3:1</span>`;
      return `<tr>
        <td>${role}</td>
        <td><code>${foreground}</code> / <code>${background}</code></td>
        <td class="ratio">${ratio.toFixed(2)}:1</td>
        <td>${badge}</td>
      </tr>`;
    })
    .join("");

  return `<section id="contrast">
  <h2>9. Контраст рабочих пар</h2>
  <p class="lead">Теоретические коэффициенты по sRGB для пар, которые встречаются в UI. Эти числа заданы токенами; калибровка монитора не меняет их, но меняет, читаются ли они на практике.</p>
  <div class="card"><table>
    <thead><tr><th>Пара</th><th>Hex</th><th>Контраст</th><th>WCAG</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>`;
}

function renderTextAndPixels(tokens, ui) {
  const byKey = new Map(tokens.map((token) => [token.key, token]));
  const text = byKey.get("whiteTemplate").hex;
  const gray = byKey.get("gray").hex;
  return `<section id="text">
  <h2>10. Текст, гало и пиксельная сетка</h2>
  <p class="lead">Реальные размеры Flora: 15 px / 300 с трекингом 0.45 px, 13 px для счётчиков. Проверяются читаемость, «звон» белого на чёрном и отсутствие масштабирования.</p>
  <div class="cols">
    <div class="textSample">
      <div class="s15" style="color:${text}">Проверка строки набора: у глифов должны быть чистые края, без радужного ореола и без размытия.</div>
      <div style="height:10px"></div>
      <div class="s13" style="color:${gray}">Второстепенный текст 13 px — приглушённый, но различимый.</div>
      <div style="height:12px"></div>
      <div class="bubble">Пузырь собеседника: фон <code>${ui.bubbleBg}</code>, текст <code>${ui.bubbleText}</code>.<time>12:48</time></div>
      <p class="note" style="margin-top:12px">Шрифт страницы — системный (Manrope в офлайне нет); для проверки читаемости этого достаточно, палитра от шрифта не зависит.</p>
    </div>
    <div class="card">
      <h3>Пиксельная сетка</h3>
      <div class="rough" data-fs="${PIXEL_GRID}"></div>
      <div style="height:10px"></div>
      <p class="note"><strong>Норма:</strong> 1 px линии резкие, без двойных контуров; наклонные и вертикальные штрихи текста без цветной каймы.
      <br><strong>Линии размыты или с радугой:</strong> включено масштабирование (не 100 %), Over Scan или ClearType по не-нативному разрешению. <strong>Белый текст «светится» ореолом:</strong> завышена Sharpness — верните 50.</p>
      <p class="note"><strong>Полноэкранный режим:</strong> клик по любой плашке/полосе; выход — <kbd>Esc</kbd> или клик.</p>
    </div>
  </div>
</section>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function grayHex(value) {
  const channel = Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
  return `#${channel}${channel}${channel}`;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb) {
  return `#${rgb
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function mixHex(firstHex, firstWeight, secondHex, secondWeight) {
  const total = firstWeight + secondWeight;
  const a = hexToRgb(firstHex);
  const b = hexToRgb(secondHex);
  return rgbToHex(
    a.map(
      (channel, index) =>
        (channel * firstWeight + b[index] * secondWeight) / total,
    ),
  );
}

function maxChannelDiff(firstHex, secondHex) {
  const a = hexToRgb(firstHex);
  const b = hexToRgb(secondHex);
  return Math.max(...a.map((channel, index) => Math.abs(channel - b[index])));
}

const toLinear = (value) => {
  const channel = value / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
};

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(firstHex, secondHex) {
  const a = relativeLuminance(hexToRgb(firstHex));
  const b = relativeLuminance(hexToRgb(secondHex));
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToLab(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (value) =>
    value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE76(firstHex, secondHex) {
  const a = rgbToLab(hexToRgb(firstHex));
  const b = rgbToLab(hexToRgb(secondHex));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

main();
