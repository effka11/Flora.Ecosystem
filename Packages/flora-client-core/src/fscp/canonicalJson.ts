/**
 * Canonical JSON для подписи envelope (docs/fscp/FSCP.md): сортировка ключей объекта,
 * UTF-8 строка без BOM, массивы рекурсивно (recipients уже отсортирован снаружи).
 */
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
    const keys = Object.keys(o).sort((a, b) => a.localeCompare(b));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}
