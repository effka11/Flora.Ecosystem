/**
 * Парсер atrace-дампа для поиска тормозов UI-потока (см.
 * docs/android-swipe-performance.md).
 *
 * Использование:
 *   node Apps/Mobile/tools/parse-atrace.mjs <trace-file> <pid>
 *
 * Печатает: топ самых долгих секций, агрегат по имени секции и дерево
 * вложенных секций двух самых медленных touch-MOVE (главный индикатор
 * стоимости свайпа). Снятие трейса:
 *   adb shell atrace --async_start -b 32768 -a <pkg> gfx view input
 *   ...жест...
 *   adb shell atrace --async_stop -o /data/local/tmp/fl.trace
 *   adb pull /data/local/tmp/fl.trace
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const pid = process.argv[3];
if (!file || !pid) {
  console.error("usage: node parse-atrace.mjs <trace-file> <pid>");
  process.exit(1);
}

const lines = readFileSync(file, "utf8").split("\n");

// ftrace: "  name-TID   ( PID) [cpu] flags TIMESTAMP: tracing_mark_write: B|PID|section"
const re = /-(\d+)\s+\(\s*(-?\d+)\)\s+\[\d+\]\s+\S+\s+([\d.]+):\s+tracing_mark_write:\s+(.*)$/;

const stacks = new Map(); // tid -> [{name, begin, depth}]
const slices = []; // завершённые секции

for (const line of lines) {
  const m = re.exec(line);
  if (!m) continue;
  const [, tid, lpid, tsStr, payload] = m;
  if (lpid !== pid) continue;
  const ts = parseFloat(tsStr);
  if (payload.startsWith("B|")) {
    let st = stacks.get(tid);
    if (!st) stacks.set(tid, (st = []));
    st.push({ name: payload.slice(payload.indexOf("|", 2) + 1), begin: ts, depth: st.length });
  } else if (payload.startsWith("E|") || payload === "E") {
    const st = stacks.get(tid);
    if (!st || st.length === 0) continue;
    const top = st.pop();
    slices.push({ tid, ...top, end: ts, dur: (ts - top.begin) * 1000 });
  }
}

const byDur = [...slices].sort((a, b) => b.dur - a.dur);

console.log("Top 40 slowest sections (ms), pid " + pid + ":");
for (const s of byDur.slice(0, 40)) {
  console.log(
    s.dur.toFixed(2).padStart(8) + "ms  tid=" + s.tid + " depth=" + s.depth + "  " + s.name.slice(0, 110),
  );
}

const agg = new Map();
for (const s of slices) {
  const a = agg.get(s.name) ?? { total: 0, count: 0, max: 0 };
  a.total += s.dur;
  a.count += 1;
  a.max = Math.max(a.max, s.dur);
  agg.set(s.name, a);
}
console.log("\nTop 30 by total time:");
for (const [name, a] of [...agg.entries()].sort((x, y) => y[1].total - x[1].total).slice(0, 30)) {
  console.log(
    a.total.toFixed(1).padStart(9) + "ms total  " + String(a.count).padStart(5) + "x  max " +
      a.max.toFixed(2).padStart(7) + "ms  " + name.slice(0, 100),
  );
}

// Дерево двух самых медленных MOVE — что именно происходит на каждое движение пальца.
const moves = byDur
  .filter((s) => s.tid === pid && s.name.startsWith("dispatchInputEvent MotionEvent MOVE"))
  .slice(0, 2);
for (const mv of moves) {
  console.log("\n=== MOVE " + mv.dur.toFixed(2) + "ms @" + mv.begin.toFixed(6) + " ===");
  const children = slices
    .filter((s) => s.tid === mv.tid && s.begin >= mv.begin && s.end <= mv.end && s.depth > mv.depth)
    .sort((a, b) => a.begin - b.begin);
  for (const c of children) {
    console.log(
      "  ".repeat(c.depth - mv.depth) + c.dur.toFixed(2) + "ms  " + c.name.slice(0, 120) +
        "  (+" + ((c.begin - mv.begin) * 1000).toFixed(2) + "ms)",
    );
  }
}
