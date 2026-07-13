/**
 * Canonical JSON для подписи envelope (docs/fscp/FSCP.md §Canonical encoding):
 * сортировка ключей объекта по UTF-16 code unit (не локале-зависимая — localeCompare
 * запрещён спекой, недетерминирован между ICU-окружениями), UTF-8 строка без BOM,
 * массивы рекурсивно в исходном порядке (recipients уже отсортирован снаружи).
 * Для ASCII-ключей v1 порядок побайтово совпадает с прежним localeCompare —
 * wire-байты и подписи не меняются (parity-тест в Packages/flora-client-core).
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number" || t === "boolean") return JSON.stringify(value);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((x) => canonicalJson(x)).join(",")}]`;
  }
  if (t === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).sort(compareCodeUnits);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}
