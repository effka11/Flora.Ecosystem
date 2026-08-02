/**
 * Consumer-тесты golden-векторов personhood (Documents/test-vectors/personhood/):
 * бит-в-бит паритет TS-слоя с эталонным Rust-ядром `fpp-core` / `fpp-crypto`.
 * Файлы Documents/test-vectors/** — regenerate-only, руками не редактировать;
 * регенерация: `cargo run -p fpp-core --example gen_personhood_vectors`.
 *
 * TS зеркалит только клиентский путь (метрики → bucket'ы → эпоха → тег → отчёт);
 * серверные секции вектора (CUSUM, калибровочные кривые, свод, панель) остаются
 * за Rust-ядром и здесь не проверяются.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { deviceTagEpoch } from "./deviceTag.js";
import { EPOCH_LEN_S, epochIdBytes, epochIndexAt, epochStartS } from "./epoch.js";
import {
  bucketEdges,
  quantize,
  temporalFromReport,
  toReportBuckets,
  quantizeRaw,
  type RawTemporalMetrics,
  type ReportedBucket,
  type TemporalBuckets,
} from "./profile.js";
import {
  CEREMONY_ANOMALY_FLAGS,
  DEVICE_ATTESTATION_CLASSES,
  DEVICE_CHURN_CLASSES,
  DEVICE_LINK_CLASSES,
  NATURALNESS_CLASSES,
  PERSONHOOD_LEVELS,
  REPORT_CONSISTENCY_CLASSES,
  SIGNAL_BUCKETS,
  SIGNAL_EVIDENCE_CLASSES,
  SIGNAL_METRICS,
  type SignalBucketName,
  type SignalMetricName,
} from "./registry.js";
import { buildEpochReport } from "./report.js";
import {
  burstinessPermille,
  peakSharePermille,
  restSharePermille,
  similarityPermille,
} from "./temporal.js";

const vectorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "Documents", "test-vectors", "personhood",
);

function loadVector<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(vectorsDir, name), "utf8")) as T;
}

function b64d(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

type RegistryEntryJson = { name: string; code: number };
type ReportedBucketJson = {
  metric: string;
  metricCode: number;
  bucket: string;
  bucketCode: number;
};
type TemporalBucketsJson = {
  nsT1Burstiness: string | null;
  nsT2aRestShare: string | null;
  nsT2bPeakShare: string | null;
  nsT2cSelfSimilarity: string | null;
};

type PositiveVector = {
  protocolVersion: number;
  vectorId: string;
  registries: Record<string, RegistryEntryJson[] | string[]>;
  burstiness: Array<{ name: string; intervalsS: number[]; permille: number | null }>;
  circadian: {
    profiles: Record<string, number[]>;
    metrics: Array<{ profile: string; restSharePermille: number | null; peakSharePermille: number | null }>;
    similarity: Array<{ a: string; b: string; permille: number | null }>;
  };
  panel: {
    buckets: Array<{
      metric: string;
      edges: number[];
      quantizeCases: Array<{ raw: number; bucket: string }>;
    }>;
  };
  epoch: {
    epochLenS: number;
    indexCases: Array<{
      name: string;
      unixS: number;
      genesisUnixS: number;
      epochLenS: number;
      epochIndex: number | null;
    }>;
    startCases: Array<{ genesisUnixS: number; epochIndex: number; startUnixS: number | null }>;
    idCases: Array<{ genesisUnixS: number; epochIndex: number; epochId: string }>;
    deviceTagForEpoch: Array<{
      genesisUnixS: number;
      epochIndex: number;
      epochId: string;
      pkDevice: string;
      tag: string;
    }>;
  };
  deviceTag: {
    pkDevice: string;
    epochId: string;
    tag: string;
    epochIdNext: string;
    tagNext: string;
  };
  epochReport: {
    cases: Array<{
      name: string;
      raw: {
        burstinessPermille: number | null;
        restSharePermille: number | null;
        peakSharePermille: number | null;
        selfSimilarityPermille: number | null;
      };
      genesisUnixS: number;
      pkDevice: string;
      report: { epochIndex: number; deviceTag: string; temporalBuckets: ReportedBucketJson[] };
      unpackedProfile: TemporalBucketsJson;
    }>;
  };
};

type NegativeVector = {
  protocolVersion: number;
  vectorId: string;
  epochReportRejects: Array<{
    name: string;
    temporalBuckets: ReportedBucketJson[];
    expectedError: string;
  }>;
  unknownWireCodes: Record<string, number[]>;
  curveRejects: Array<{ name: string; expectedError: string }>;
};

const positive = loadVector<PositiveVector>("personhood-naturalness-v1.json");
const negative = loadVector<NegativeVector>("personhood-naturalness-negative-v1.json");

/** codeOf контравариантен по имени — для перебора реестров достаточно этой формы. */
type AnyRegistry = {
  entries: readonly { name: string; code: number }[];
  fromCode(code: number): string | null;
};
const REGISTRY_BY_KEY: Record<string, AnyRegistry> = {
  personhoodLevel: PERSONHOOD_LEVELS,
  signalEvidenceClass: SIGNAL_EVIDENCE_CLASSES,
  naturalnessClass: NATURALNESS_CLASSES,
  deviceAttestationClass: DEVICE_ATTESTATION_CLASSES,
  deviceLinkClass: DEVICE_LINK_CLASSES,
  deviceChurnClass: DEVICE_CHURN_CLASSES,
  reportConsistencyClass: REPORT_CONSISTENCY_CLASSES,
  signalMetric: SIGNAL_METRICS,
  signalBucket: SIGNAL_BUCKETS,
  ceremonyAnomalyFlag: CEREMONY_ANOMALY_FLAGS,
};

function rowsFromJson(rows: ReportedBucketJson[]): ReportedBucket[] {
  return rows.map((row) => {
    const metric = SIGNAL_METRICS.fromCode(row.metricCode);
    const bucket = SIGNAL_BUCKETS.fromCode(row.bucketCode);
    expect(metric).toBe(row.metric);
    expect(bucket).toBe(row.bucket);
    return { metric: metric as SignalMetricName, bucket: bucket as SignalBucketName };
  });
}

function profileFromJson(json: TemporalBucketsJson): TemporalBuckets {
  return {
    burstiness: (json.nsT1Burstiness ?? null) as SignalBucketName | null,
    restShare: (json.nsT2aRestShare ?? null) as SignalBucketName | null,
    peakShare: (json.nsT2bPeakShare ?? null) as SignalBucketName | null,
    selfSimilarity: (json.nsT2cSelfSimilarity ?? null) as SignalBucketName | null,
  };
}

describe("golden: personhood-naturalness-v1.json", () => {
  it("заголовок вектора", () => {
    expect(positive.vectorId).toBe("personhood_naturalness_v1");
  });

  it("wire-реестры совпадают байт-в-байт", () => {
    for (const [key, reg] of Object.entries(REGISTRY_BY_KEY)) {
      const entries = positive.registries[key] as RegistryEntryJson[];
      expect(entries, key).toBeDefined();
      expect(entries.map((e) => ({ name: e.name, code: e.code })), key).toEqual(
        reg.entries.map((e) => ({ name: e.name, code: e.code })),
      );
      for (const entry of entries) {
        expect(reg.fromCode(entry.code), `${key} код ${entry.code}`).toBe(entry.name);
      }
    }
    expect(positive.registries.epochReportError).toEqual([
      "non_temporal_metric",
      "duplicate_metric",
      "out_of_order",
    ]);
    // Калибровочные кривые — серверный R2-механизм; TS фиксирует только имена отказов.
    expect(positive.registries.curveError).toEqual([
      "empty",
      "y_above_permille",
      "non_increasing_x",
    ]);
  });

  it("NS-T1 burstiness", () => {
    for (const c of positive.burstiness) {
      expect(burstinessPermille(c.intervalsS), c.name).toBe(c.permille);
    }
  });

  it("NS-T2 суточный профиль", () => {
    const profiles = positive.circadian.profiles;
    for (const m of positive.circadian.metrics) {
      const counts = profiles[m.profile]!;
      expect(restSharePermille(counts), m.profile).toBe(m.restSharePermille);
      expect(peakSharePermille(counts), m.profile).toBe(m.peakSharePermille);
    }
    for (const s of positive.circadian.similarity) {
      expect(similarityPermille(profiles[s.a]!, profiles[s.b]!), `${s.a}~${s.b}`).toBe(s.permille);
    }
  });

  it("квантование в bucket'ы", () => {
    for (const section of positive.panel.buckets) {
      const metric = section.metric as SignalMetricName;
      expect(bucketEdges(metric), metric).toEqual(section.edges);
      for (const c of section.quantizeCases) {
        expect(quantize(metric, c.raw), `${metric} @ ${c.raw}`).toBe(c.bucket);
      }
    }
  });

  it("каноническая эпоха", () => {
    const e = positive.epoch;
    expect(e.epochLenS).toBe(EPOCH_LEN_S);
    for (const c of e.indexCases) {
      expect(epochIndexAt(c.unixS, c.genesisUnixS, c.epochLenS), c.name).toBe(c.epochIndex);
    }
    for (const c of e.startCases) {
      expect(epochStartS(c.genesisUnixS, c.epochIndex, e.epochLenS)).toBe(c.startUnixS);
    }
    for (const c of e.idCases) {
      expect(epochIdBytes(c.genesisUnixS, c.epochIndex)).toEqual(b64d(c.epochId));
    }
    for (const c of e.deviceTagForEpoch) {
      const id = epochIdBytes(c.genesisUnixS, c.epochIndex);
      expect(id).toEqual(b64d(c.epochId));
      expect(deviceTagEpoch(b64d(c.pkDevice), id)).toEqual(b64d(c.tag));
    }
  });

  it("эпохальный девайс-тег (BLAKE3 derive_key)", () => {
    const d = positive.deviceTag;
    const pk = b64d(d.pkDevice);
    expect(deviceTagEpoch(pk, b64d(d.epochId))).toEqual(b64d(d.tag));
    expect(deviceTagEpoch(pk, b64d(d.epochIdNext))).toEqual(b64d(d.tagNext));
  });

  it("отчёт эпохи: клиентский путь", () => {
    for (const c of positive.epochReport.cases) {
      const report = buildEpochReport({
        pkDevice: b64d(c.pkDevice),
        genesisUnixS: c.genesisUnixS,
        epochIndex: c.report.epochIndex,
        raw: c.raw as RawTemporalMetrics,
      });
      expect(report.epochIndex, c.name).toBe(c.report.epochIndex);
      expect(report.deviceTag, c.name).toEqual(b64d(c.report.deviceTag));
      expect(report.temporalBuckets, c.name).toEqual(rowsFromJson(c.report.temporalBuckets));

      // Раунд-трип: сервер распакует канонические строки в тот же профиль.
      const parsed = temporalFromReport(report.temporalBuckets);
      expect(parsed.ok, c.name).toBe(true);
      if (parsed.ok) {
        expect(parsed.profile, c.name).toEqual(profileFromJson(c.unpackedProfile));
        expect(toReportBuckets(parsed.profile), c.name).toEqual(report.temporalBuckets);
        expect(quantizeRaw(c.raw as RawTemporalMetrics), c.name).toEqual(parsed.profile);
      }
    }
  });
});

describe("golden: personhood-naturalness-negative-v1.json", () => {
  it("заголовок вектора", () => {
    expect(negative.vectorId).toBe("personhood_naturalness_negative_v1");
    expect(negative.protocolVersion).toBe(positive.protocolVersion);
  });

  it("отказы формы самоотчёта эпохи", () => {
    for (const c of negative.epochReportRejects) {
      const parsed = temporalFromReport(rowsFromJson(c.temporalBuckets));
      expect(parsed, c.name).toEqual({ ok: false, error: c.expectedError });
    }
  });

  it("неизвестные wire-коды отклоняются", () => {
    for (const [key, codes] of Object.entries(negative.unknownWireCodes)) {
      const reg = REGISTRY_BY_KEY[key];
      expect(reg, key).toBeDefined();
      for (const code of codes) {
        expect(reg!.fromCode(code), `${key} код ${code}`).toBeNull();
      }
    }
  });

  it("имена отказов кривых — из замороженного реестра", () => {
    // Сами кривые — серверная логика (fpp-core::piecewise); TS их не зеркалит.
    const known = positive.registries.curveError as string[];
    for (const c of negative.curveRejects) {
      expect(known, c.name).toContain(c.expectedError);
    }
  });
});
