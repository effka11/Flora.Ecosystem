// BD-Rate (Bjøntegaard delta rate) двух RD-кривых из CSV бенчмарка.
// Использование: node tools/bdrate.mjs <bench.csv> <codecA> <codecB>
// Печатает средний прирост битрейта codecA относительно codecB при равном PSNR
// (отрицательное значение = codecA эффективнее).
//
// Классический метод: кубическая аппроксимация log10(rate) = f(PSNR) по МНК,
// интегрирование разности на пересечении диапазонов PSNR.

import { readFileSync } from "node:fs";

const [file, a, b] = process.argv.slice(2);
if (!file || !a || !b) {
  console.error("usage: node bdrate.mjs <bench.csv> <codecA> <codecB>");
  process.exit(1);
}

// PowerShell (Tee-Object/redirect) пишет UTF-16LE с BOM — определяем кодировку по BOM.
const raw = readFileSync(file);
const text =
  raw[0] === 0xff && raw[1] === 0xfe
    ? raw.toString("utf16le")
    : raw.toString("utf8").replace(/^\uFEFF/, "");

const rows = text
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.split(","))
  .filter((c) => c.length >= 5)
  .map(([codec, point, bytes, bpp, psnr]) => ({ codec, bpp: +bpp, psnr: +psnr }));

const curve = (name) =>
  rows
    .filter((r) => r.codec === name)
    .map((r) => ({ x: r.psnr, y: Math.log10(r.bpp) }))
    .sort((p, q) => p.x - q.x);

// МНК-подгонка полинома степени 3: возвращает коэффициенты [c0..c3].
function polyfit(points) {
  const deg = Math.min(3, points.length - 1);
  const m = deg + 1;
  const ata = Array.from({ length: m }, () => new Array(m).fill(0));
  const atb = new Array(m).fill(0);
  for (const { x, y } of points) {
    const powers = Array.from({ length: m }, (_, i) => x ** i);
    for (let i = 0; i < m; i++) {
      atb[i] += powers[i] * y;
      for (let j = 0; j < m; j++) ata[i][j] += powers[i] * powers[j];
    }
  }
  // Гауссово исключение с выбором главного элемента.
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(ata[r][col]) > Math.abs(ata[piv][col])) piv = r;
    [ata[col], ata[piv]] = [ata[piv], ata[col]];
    [atb[col], atb[piv]] = [atb[piv], atb[col]];
    for (let r = col + 1; r < m; r++) {
      const f = ata[r][col] / ata[col][col];
      for (let c = col; c < m; c++) ata[r][c] -= f * ata[col][c];
      atb[r] -= f * atb[col];
    }
  }
  const coef = new Array(m).fill(0);
  for (let r = m - 1; r >= 0; r--) {
    let s = atb[r];
    for (let c = r + 1; c < m; c++) s -= ata[r][c] * coef[c];
    coef[r] = s / ata[r][r];
  }
  return coef;
}

const evalPoly = (c, x) => c.reduce((acc, ci, i) => acc + ci * x ** i, 0);

function integral(coefs, lo, hi, steps = 1000) {
  let s = 0;
  const dx = (hi - lo) / steps;
  for (let i = 0; i < steps; i++) {
    s += evalPoly(coefs, lo + (i + 0.5) * dx) * dx;
  }
  return s;
}

const ca = curve(a);
const cb = curve(b);
if (ca.length < 4 || cb.length < 4) {
  console.error(`need >=4 points per codec (have ${a}:${ca.length}, ${b}:${cb.length})`);
  process.exit(1);
}

const lo = Math.max(ca[0].x, cb[0].x);
const hi = Math.min(ca.at(-1).x, cb.at(-1).x);
if (hi <= lo) {
  console.error("PSNR ranges do not overlap");
  process.exit(1);
}

const fa = polyfit(ca);
const fb = polyfit(cb);
const avgDiff = (integral(fa, lo, hi) - integral(fb, lo, hi)) / (hi - lo);
const bd = (10 ** avgDiff - 1) * 100;
console.log(
  `BD-Rate ${a} vs ${b}: ${bd.toFixed(2)}% (PSNR ${lo.toFixed(2)}..${hi.toFixed(2)} dB; ` +
    `${bd < 0 ? a + " эффективнее" : b + " эффективнее"})`
);
