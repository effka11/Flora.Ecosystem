/**
 * Bucket-профиль темпоральных метрик — клиентская половина модели данных NS
 * (зеркало `fpp-core::profile`, FPP-SIGNALS §3).
 *
 * Устройство сводит сырую метрику к 5-уровневому bucket'у; точное значение
 * никуда не уходит (защита от поведенческого фингерпринтинга). Границы
 * bucket'ов — R2-параметры, зафиксированы вектором `personhood-naturalness-v1.json`.
 */

import {
  SIGNAL_BUCKETS,
  SIGNAL_METRICS,
  type SignalBucketName,
  type SignalMetricName,
} from "./registry.js";

/** Темпоральные метрики bucket-профиля (канонический порядок отчёта и векторов). */
export const TEMPORAL_METRICS: readonly SignalMetricName[] = [
  "ns_t1_burstiness",
  "ns_t2a_rest_share",
  "ns_t2b_peak_share",
  "ns_t2c_self_similarity",
];

/** Верхние исключающие границы bucket'ов 0..=3 (всё ≥ последней — bucket 4). R2. */
export const BUCKET_EDGES: Partial<
  Record<SignalMetricName, readonly [number, number, number, number]>
> = {
  ns_t1_burstiness: [-600, -200, 200, 600],
  ns_t2a_rest_share: [25, 75, 150, 220],
  ns_t2b_peak_share: [60, 90, 260, 550],
  ns_t2c_self_similarity: [200, 400, 850, 950],
};

/** Границы bucket'ов темпоральной метрики; `null` для девайс-метрик (NS-D2/D3). */
export function bucketEdges(
  metric: SignalMetricName,
): readonly [number, number, number, number] | null {
  return BUCKET_EDGES[metric] ?? null;
}

/** Квантовать сырую метрику в bucket: первый `i` с `raw < edges[i]`, иначе 4. */
export function quantize(metric: SignalMetricName, raw: number): SignalBucketName | null {
  const edges = bucketEdges(metric);
  if (edges === null) return null;
  let idx = edges.findIndex((e) => raw < e);
  if (idx === -1) idx = 4;
  return SIGNAL_BUCKETS.fromCode(idx);
}

/** Bucket-профиль одного наблюдателя; отсутствующая метрика нейтральна (§6). */
export type TemporalBuckets = {
  burstiness: SignalBucketName | null;
  restShare: SignalBucketName | null;
  peakShare: SignalBucketName | null;
  selfSimilarity: SignalBucketName | null;
};

export function emptyTemporalBuckets(): TemporalBuckets {
  return { burstiness: null, restShare: null, peakShare: null, selfSimilarity: null };
}

function getBucket(profile: TemporalBuckets, metric: SignalMetricName): SignalBucketName | null {
  switch (metric) {
    case "ns_t1_burstiness":
      return profile.burstiness;
    case "ns_t2a_rest_share":
      return profile.restShare;
    case "ns_t2b_peak_share":
      return profile.peakShare;
    case "ns_t2c_self_similarity":
      return profile.selfSimilarity;
    default:
      return null;
  }
}

function setBucket(
  profile: TemporalBuckets,
  metric: SignalMetricName,
  bucket: SignalBucketName,
): boolean {
  switch (metric) {
    case "ns_t1_burstiness":
      profile.burstiness = bucket;
      return true;
    case "ns_t2a_rest_share":
      profile.restShare = bucket;
      return true;
    case "ns_t2b_peak_share":
      profile.peakShare = bucket;
      return true;
    case "ns_t2c_self_similarity":
      profile.selfSimilarity = bucket;
      return true;
    default:
      return false;
  }
}

/** Сырые значения метрик (выходы `temporal.ts`), ‰; `null` — метрика отсутствует. */
export type RawTemporalMetrics = {
  burstinessPermille: number | null;
  restSharePermille: number | null;
  peakSharePermille: number | null;
  selfSimilarityPermille: number | null;
};

/** Клиентский путь «метрика → bucket» перед отчётом эпохи. */
export function quantizeRaw(raw: RawTemporalMetrics): TemporalBuckets {
  const q = (metric: SignalMetricName, value: number | null) =>
    value === null ? null : quantize(metric, value);
  return {
    burstiness: q("ns_t1_burstiness", raw.burstinessPermille),
    restShare: q("ns_t2a_rest_share", raw.restSharePermille),
    peakShare: q("ns_t2b_peak_share", raw.peakSharePermille),
    selfSimilarity: q("ns_t2c_self_similarity", raw.selfSimilarityPermille),
  };
}

/** Одна строка самоотчёта эпохи: метрика и её bucket (зеркало `ReportedBucket`). */
export type ReportedBucket = {
  metric: SignalMetricName;
  bucket: SignalBucketName;
};

/**
 * Строки самоотчёта эпохи из профиля — канонический порядок (по возрастанию
 * кода метрики); отсутствующие метрики не включаются. Обратная операция —
 * [`temporalFromReport`].
 */
export function toReportBuckets(profile: TemporalBuckets): ReportedBucket[] {
  const rows: ReportedBucket[] = [];
  for (const metric of TEMPORAL_METRICS) {
    const bucket = getBucket(profile, metric);
    if (bucket !== null) rows.push({ metric, bucket });
  }
  return rows;
}

/** Стабильные имена ошибок формы самоотчёта эпохи (журналы и негативные векторы). */
export type EpochReportError =
  | "non_temporal_metric"
  | "duplicate_metric"
  | "out_of_order";

/** Результат валидации самоотчёта: профиль либо первое нарушение формы. */
export type EpochReportParse =
  | { ok: true; profile: TemporalBuckets }
  | { ok: false; error: EpochReportError };

/**
 * Валидация и распаковка строк самоотчёта эпохи в bucket-профиль
 * (зеркало `fpp-core::profile::temporal_from_report`, FPP-SIGNALS §7).
 *
 * Требования формы: только темпоральные метрики; коды метрик строго возрастают
 * (дубли и беспорядок отклоняются — канонический порядок исключает скрытые
 * каналы в перестановках); пустой список валиден — нейтральное отсутствие (§6).
 * Возвращается первое нарушение в порядке скана; внутри строки метрика
 * проверяется раньше порядка.
 */
export function temporalFromReport(rows: readonly ReportedBucket[]): EpochReportParse {
  const profile = emptyTemporalBuckets();
  let prevCode: number | null = null;
  for (const row of rows) {
    if (bucketEdges(row.metric) === null) {
      return { ok: false, error: "non_temporal_metric" };
    }
    const code = SIGNAL_METRICS.codeOf(row.metric);
    if (prevCode !== null) {
      if (code === prevCode) return { ok: false, error: "duplicate_metric" };
      if (code < prevCode) return { ok: false, error: "out_of_order" };
    }
    setBucket(profile, row.metric, row.bucket);
    prevCode = code;
  }
  return { ok: true, profile };
}
