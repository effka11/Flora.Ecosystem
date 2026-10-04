/** Tolerant JSON field reader — camelCase primary; PascalCase fallback logs telemetry once per key. */
function shouldReportPascalFallback(key: string, index: number): boolean {
  if (index === 0) return false;
  const first = key.charAt(0);
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

export function readStr(
  obj: Record<string, unknown>,
  keys: string[],
  onPascalFallback?: (key: string) => void,
): string {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const v = obj[k];
    if (typeof v === "string") {
      if (shouldReportPascalFallback(k, i) && onPascalFallback) onPascalFallback(k);
      return v;
    }
  }
  return "";
}

export function readNum(
  obj: Record<string, unknown>,
  keys: string[],
  onPascalFallback?: (key: string) => void,
): number | undefined {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      if (shouldReportPascalFallback(k, i) && onPascalFallback) onPascalFallback(k);
      return v;
    }
  }
  return undefined;
}

export function readBool(
  obj: Record<string, unknown>,
  keys: string[],
  onPascalFallback?: (key: string) => void,
): boolean {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const v = obj[k];
    if (typeof v === "boolean") {
      if (shouldReportPascalFallback(k, i) && onPascalFallback) onPascalFallback(k);
      return v;
    }
  }
  return false;
}

export function readStrArray(
  obj: Record<string, unknown>,
  keys: string[],
): string[] {
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) {
      return v.filter((x): x is string => typeof x === "string");
    }
  }
  return [];
}

export type ParseContext = {
  onPascalFallback?: (key: string) => void;
};

export function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}
