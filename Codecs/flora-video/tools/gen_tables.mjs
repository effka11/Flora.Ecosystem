// Генератор нормативных таблиц FVC1 (docs/codecs/FVC.md).
// Запуск: node tools/gen_tables.mjs — перезаписывает crates/fvc/src/tables.rs.
// Таблицы фиксируются в исходнике константами: нормативный путь декодера не использует float.

import { writeFileSync } from "node:fs";

const out = [];
console.log = (s = "") => out.push(s);

console.log("//! Нормативные таблицы битстрима FVC1.");
console.log("//!");
console.log("//! Файл сгенерирован `tools/gen_tables.mjs` — руками не редактировать,");
console.log("//! перегенерация: `node tools/gen_tables.mjs`. Формулы — в генераторе и в docs/codecs/FVC.md.");
console.log("");

// Матрица T[k][j] = round(64*sqrt(2)*ck*cos(pi*(2j+1)k / 2N)), ck = 1/sqrt(2) при k=0.
// Это T ≈ 64*sqrt(N) * O, где O — ортонормальная DCT-II; DC-строка = 64 для всех N,
// максимум |T| = 91 — одинаковая относительная точность у всех размеров.
function dctMatrix(n) {
  const scale = 64 * Math.SQRT2;
  const rows = [];
  for (let k = 0; k < n; k++) {
    const ck = k === 0 ? Math.SQRT1_2 : 1;
    const row = [];
    for (let j = 0; j < n; j++) {
      row.push(Math.round(scale * ck * Math.cos((Math.PI * (2 * j + 1) * k) / (2 * n))));
    }
    rows.push(row);
  }
  return rows;
}

function emitMatrix(n) {
  const m = dctMatrix(n);
  console.log(`pub const DCT${n}: [[i32; ${n}]; ${n}] = [`);
  for (const row of m) {
    console.log(`    [${row.join(", ")}],`);
  }
  console.log(`];`);
  console.log("");
}

for (const n of [4, 8, 16, 32]) emitMatrix(n);

// Квантование: домен коэффициентов = 8 * ортонормальная DCT (см. transform.rs).
// ac_step(q) = round(8 * 2^(q/8)) — q=0 почти без потерь, каждый +8 к q удваивает шаг.
// dc_step(q) = max(6, round(0.8 * ac_step(q))) — DC квантуем мягче (глаз чувствительнее).
const ac = [];
const dc = [];
for (let q = 0; q < 64; q++) {
  const a = Math.round(8 * Math.pow(2, q / 8));
  ac.push(a);
  dc.push(Math.max(6, Math.round(0.8 * a)));
}
console.log(`pub const AC_STEP: [i32; 64] = [${ac.join(", ")}];`);
console.log(`pub const DC_STEP: [i32; 64] = [${dc.join(", ")}];`);
console.log("");

// Стоимость бита в 1/256 бита: cost256[p] = round(-log2(p/256)*256) для p=P(закодированного значения).
// p=0 не встречается (вероятности в диапазоне 1..=255). Индекс 0 — заглушка.
const cost = [65535];
for (let p = 1; p <= 255; p++) {
  cost.push(Math.round(-Math.log2(p / 256) * 256));
}
console.log(`pub const BIT_COST_256: [u16; 256] = [${cost.join(", ")}];`);

writeFileSync(new URL("../crates/fvc/src/tables.rs", import.meta.url), out.join("\n") + "\n", "utf8");
