/**
 * Wire-реестры FPP (зеркало `fpp-contracts`, FPP-SIGNALS §7).
 *
 * Правило кодов: в **реестрах классов** код `0` зарезервирован («не задано»)
 * и не сериализуется; порядковые шкалы — `PersonhoodLevel` (номер уровня) и
 * `SignalBucket` (квантованная величина 0..=4) — сохраняют смысловые коды,
 * включая 0. Имена и коды зафиксированы вектором
 * `personhood-naturalness-v1.json` (regenerate-only).
 */

/** Ошибка кодека personhood-слоя: некорректная форма данных на границе. */
export class PersonhoodCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonhoodCodecError";
  }
}

/** Пара «стабильное имя — wire-код» одного реестра. */
export type RegistryEntry<TName extends string> = {
  readonly name: TName;
  readonly code: number;
};

/** Реестр wire-кодов: список пар + конверсии (неизвестный код → `null`, не «ближайший»). */
export type Registry<TName extends string> = {
  readonly entries: readonly RegistryEntry<TName>[];
  codeOf(name: TName): number;
  fromCode(code: number): TName | null;
};

function registry<TName extends string>(
  pairs: readonly (readonly [TName, number])[],
): Registry<TName> {
  const entries = pairs.map(([name, code]) => Object.freeze({ name, code }));
  const byName = new Map(pairs);
  const byCode = new Map(pairs.map(([name, code]) => [code, name] as const));
  return Object.freeze({
    entries: Object.freeze(entries),
    codeOf(name: TName): number {
      const code = byName.get(name);
      if (code === undefined) {
        throw new PersonhoodCodecError(`имя вне реестра: ${name}`);
      }
      return code;
    },
    fromCode(code: number): TName | null {
      return byCode.get(code) ?? null;
    },
  });
}

/** Уровень personhood V0–V3 (FPP §2); код = номер уровня. */
export type PersonhoodLevelName = "v0" | "v1" | "v2" | "v3";
export const PERSONHOOD_LEVELS: Registry<PersonhoodLevelName> = registry([
  ["v0", 0],
  ["v1", 1],
  ["v2", 2],
  ["v3", 3],
]);

/** Класс доказательности NS-сигнала (FPP-SIGNALS §1): важно, кто наблюдал. */
export type SignalEvidenceClassName =
  | "server_observed"
  | "device_attested"
  | "self_reported";
export const SIGNAL_EVIDENCE_CLASSES: Registry<SignalEvidenceClassName> = registry([
  ["server_observed", 1],
  ["device_attested", 2],
  ["self_reported", 3],
]);

/** Итоговый класс натуральности (FPP-SIGNALS §4; advisory-only, FPP §8.3). */
export type NaturalnessClassName = "natural" | "watch" | "investigate";
export const NATURALNESS_CLASSES: Registry<NaturalnessClassName> = registry([
  ["natural", 1],
  ["watch", 2],
  ["investigate", 3],
]);

/** NS-D1: класс аттестации устройства (присваивает сервер, не самодекларация). */
export type DeviceAttestationClassName =
  | "unattested"
  | "software_key"
  | "hardware_backed";
export const DEVICE_ATTESTATION_CLASSES: Registry<DeviceAttestationClassName> = registry([
  ["unattested", 1],
  ["software_key", 2],
  ["hardware_backed", 3],
]);

/** NS-D2: конкурентность личностей на девайс-теге эпохи. */
export type DeviceLinkClassName = "exclusive" | "shared" | "farm_suspect";
export const DEVICE_LINK_CLASSES: Registry<DeviceLinkClassName> = registry([
  ["exclusive", 1],
  ["shared", 2],
  ["farm_suspect", 3],
]);

/** NS-D3: текучка девайс-тегов личности за эпоху. */
export type DeviceChurnClassName = "stable" | "mobile" | "churning";
export const DEVICE_CHURN_CLASSES: Registry<DeviceChurnClassName> = registry([
  ["stable", 1],
  ["mobile", 2],
  ["churning", 3],
]);

/** Согласованность самоотчёта с серверными наблюдениями (FPP-SIGNALS §4.1). */
export type ReportConsistencyClassName = "consistent" | "drifting" | "contradictory";
export const REPORT_CONSISTENCY_CLASSES: Registry<ReportConsistencyClassName> = registry([
  ["consistent", 1],
  ["drifting", 2],
  ["contradictory", 3],
]);

/** Метрика NS-слоя (FPP-SIGNALS §2). */
export type SignalMetricName =
  | "ns_t1_burstiness"
  | "ns_t2a_rest_share"
  | "ns_t2b_peak_share"
  | "ns_t2c_self_similarity"
  | "ns_d2_device_link"
  | "ns_d3_device_churn";
export const SIGNAL_METRICS: Registry<SignalMetricName> = registry([
  ["ns_t1_burstiness", 1],
  ["ns_t2a_rest_share", 2],
  ["ns_t2b_peak_share", 3],
  ["ns_t2c_self_similarity", 4],
  ["ns_d2_device_link", 5],
  ["ns_d3_device_churn", 6],
]);

/** 5-уровневый bucket квантованной метрики (порядковая шкала, 0 значим). */
export type SignalBucketName = "very_low" | "low" | "medium" | "high" | "very_high";
export const SIGNAL_BUCKETS: Registry<SignalBucketName> = registry([
  ["very_low", 0],
  ["low", 1],
  ["medium", 2],
  ["high", 3],
  ["very_high", 4],
]);

/** Enum-флаги аномалий liveness-церемоний (FPP §3.1, §9.1; свободный текст запрещён). */
export type CeremonyAnomalyFlagName =
  | "latency_suspect"
  | "synthetic_media_suspect"
  | "audio_video_desync"
  | "challenge_mismatch"
  | "input_cadence_anomaly"
  | "participant_aborted"
  | "abuse_reported"
  | "partner_no_show";
export const CEREMONY_ANOMALY_FLAGS: Registry<CeremonyAnomalyFlagName> = registry([
  ["latency_suspect", 1],
  ["synthetic_media_suspect", 2],
  ["audio_video_desync", 3],
  ["challenge_mismatch", 4],
  ["input_cadence_anomaly", 5],
  ["participant_aborted", 6],
  ["abuse_reported", 7],
  ["partner_no_show", 8],
]);
