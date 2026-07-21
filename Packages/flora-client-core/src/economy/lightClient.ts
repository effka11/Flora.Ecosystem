/**
 * Лёгкий клиент LIV — уровни проверки L0/L1 (LIV.md §5).
 *
 * - **L0**: моя запись действительно в журнале (inclusion-доказательство против head).
 * - **L1**: журнал только дописывается (consistency между запомненным и новым head)
 *   и head подтверждён витнессами. Расхождение — доказательство форка, а не «ошибка сети».
 * - Промежуточно клиент может пересчитать **хеш-цепочку и Merkle-корень** всех записей
 *   без экономических инвариантов ([`replayHashChain`]). Полный реплей с инвариантами —
 *   уровень L2: wasm-поверхность ядра (`flora-economy-wasm`), логика не дублируется.
 */

import { fromHex, toHex } from "./encoding.js";
import { zeroHash } from "./hash.js";
import { entryHash, type LedgerEntryJson, type LedgerHeadJson } from "./ledger.js";
import { merkleLeafHash, merkleRoot, verifyConsistency, verifyInclusion } from "./merkle.js";
import { isRegisteredWitness, verifyHeadCosign, type HeadCosignJson } from "./witness.js";

/** L0: запись входит в журнал с данным head (лист = `seq`, доказательство от сервера). */
export function verifyEntryInclusion(
  entry: LedgerEntryJson,
  proofHex: readonly string[],
  head: LedgerHeadJson,
): boolean {
  let leaf: Uint8Array;
  let proof: Uint8Array[];
  let root: Uint8Array;
  try {
    leaf = merkleLeafHash(entryHash(entry));
    proof = proofHex.map((h) => fromHex(h, 32));
    root = fromHex(head.merkleRoot, 32);
  } catch {
    return false;
  }
  return verifyInclusion(leaf, entry.seq, head.size, proof, root);
}

/** Результат продвижения доверенного head (L1). */
export type HeadAdvanceResult =
  | {
      ok: true;
      head: LedgerHeadJson;
      /** Сколько косайнов криптографически валидны, из реестра и ровно на этот head. */
      confirmedCosigns: number;
      /** Валидные косайны из реестра, но на другой (обычно более старый) head. */
      staleCosigns: number;
    }
  | {
      ok: false;
      /**
       * - `size_regression` / `same_size_different_head` / `consistency_failed` —
       *   доказательство форка или отказ сервера доказать append-only: сохраните оба
       *   head как улику и не принимайте новый.
       * - `missing_consistency_proof` — сервер не дал доказательство; head не принят.
       */
      reason:
        | "size_regression"
        | "same_size_different_head"
        | "missing_consistency_proof"
        | "consistency_failed";
      trusted: LedgerHeadJson;
      offered: LedgerHeadJson;
    };

/**
 * L1: принять новый head, только если он криптографически совместим с запомненным.
 * `trusted === null` — первый запуск (TOFU): head принимается, доверие копится дальше.
 */
export function advanceTrustedHead(input: {
  trusted: LedgerHeadJson | null;
  offered: LedgerHeadJson;
  /** Consistency-доказательство `trusted.size → offered.size` (обязательно при росте). */
  consistencyProofHex?: readonly string[];
  /** Косайны из STH-ответа. */
  cosigns?: readonly HeadCosignJson[];
  /** Реестр витнессов (hex-ключи) — из STH-ответа или локальной конфигурации. */
  witnessesHex?: readonly string[];
}): HeadAdvanceResult {
  const { trusted, offered } = input;

  if (trusted !== null) {
    if (offered.size < trusted.size) {
      return { ok: false, reason: "size_regression", trusted, offered };
    }
    if (offered.size === trusted.size) {
      const same =
        offered.merkleRoot.toLowerCase() === trusted.merkleRoot.toLowerCase() &&
        offered.lastEntryHash.toLowerCase() === trusted.lastEntryHash.toLowerCase();
      if (!same) {
        return { ok: false, reason: "same_size_different_head", trusted, offered };
      }
    } else {
      const proofHex = input.consistencyProofHex;
      if (proofHex === undefined) {
        return { ok: false, reason: "missing_consistency_proof", trusted, offered };
      }
      let consistent = false;
      try {
        consistent = verifyConsistency(
          trusted.size,
          offered.size,
          fromHex(trusted.merkleRoot, 32),
          fromHex(offered.merkleRoot, 32),
          proofHex.map((h) => fromHex(h, 32)),
        );
      } catch {
        consistent = false;
      }
      if (!consistent) {
        return { ok: false, reason: "consistency_failed", trusted, offered };
      }
    }
  }

  let confirmedCosigns = 0;
  let staleCosigns = 0;
  const registry = input.witnessesHex ?? [];
  for (const cosign of input.cosigns ?? []) {
    if (!verifyHeadCosign(cosign)) continue;
    if (registry.length > 0 && !isRegisteredWitness(cosign, registry)) continue;
    const sameHead =
      cosign.head.size === offered.size &&
      cosign.head.merkleRoot.toLowerCase() === offered.merkleRoot.toLowerCase() &&
      cosign.head.lastEntryHash.toLowerCase() === offered.lastEntryHash.toLowerCase() &&
      cosign.head.at === offered.at;
    if (sameHead) {
      confirmedCosigns += 1;
    } else {
      staleCosigns += 1;
    }
  }

  return { ok: true, head: offered, confirmedCosigns, staleCosigns };
}

/** Результат реплея хеш-цепочки (без экономических инвариантов — они в L2/wasm). */
export type HashChainReplay =
  | { ok: true; head: LedgerHeadJson }
  | { ok: false; seq: number; reason: string };

/**
 * Пересчитать хеш-цепочку и Merkle-корень по полному списку записей: плотность `seq`,
 * `prevHash`-сцепление, монотонность времени, итоговый head. Экономические инварианты
 * (балансы, подписи, сохранение) проверяет только детерминированное ядро (L2, wasm).
 */
export function replayHashChain(entries: readonly LedgerEntryJson[]): HashChainReplay {
  if (entries.length === 0) {
    return { ok: false, seq: 0, reason: "пустой журнал: нет genesis-записи" };
  }
  let prev = zeroHash();
  let prevAt = Number.NEGATIVE_INFINITY;
  const leaves: Uint8Array[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.seq !== i) {
      return { ok: false, seq: i, reason: `разрыв нумерации: ожидался seq ${i}, получен ${entry.seq}` };
    }
    if (entry.prevHash.toLowerCase() !== toHex(prev)) {
      return { ok: false, seq: i, reason: "разрыв хеш-цепочки: prevHash не совпадает" };
    }
    if (entry.at < prevAt) {
      return { ok: false, seq: i, reason: "время записи идёт вспять" };
    }
    let hash: Uint8Array;
    try {
      hash = entryHash(entry);
    } catch (error) {
      return { ok: false, seq: i, reason: `некорректная запись: ${String(error)}` };
    }
    leaves.push(merkleLeafHash(hash));
    prev = hash;
    prevAt = entry.at;
  }
  const last = entries[entries.length - 1]!;
  return {
    ok: true,
    head: {
      size: entries.length,
      lastEntryHash: toHex(prev),
      merkleRoot: toHex(merkleRoot(leaves)),
      at: last.at,
    },
  };
}
