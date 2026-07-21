/**
 * Интеграция TS-обвязки с реальным артефактом `flora-economy-wasm` (L2-реплей ядром).
 *
 * Тесты выполняются, когда артефакт собран:
 * `cargo build -p flora-economy-wasm --target wasm32-unknown-unknown --release`
 * (иначе — skip: юнит-CI не зависит от cargo; ABI-паритет дополнительно зафиксирован
 * native-тестами крейта). Паритет с golden-векторами — и здесь: ядро в wasm обязано
 * давать те же головы/хеши, что Rust native и TS.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { fromHex, toHex } from "./encoding.js";
import { entryHash, parseLedgerEntry, parseLedgerHead } from "./ledger.js";
import { merkleLeafHash } from "./merkle.js";
import { FepWasmVerifier } from "./wasm.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
);
const vectorsDir = path.join(repoRoot, "Documents", "test-vectors", "fep");
const artifactCandidates = [
  path.join(repoRoot, "Target", "wasm32-unknown-unknown", "release", "flora_economy_wasm.wasm"),
  path.join(repoRoot, "Target", "wasm32-unknown-unknown", "debug", "flora_economy_wasm.wasm"),
];
const artifact = artifactCandidates.find((p) => existsSync(p));

function loadVector<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(vectorsDir, name), "utf8")) as T;
}

describe.skipIf(artifact === undefined)("wasm L2: flora-economy-wasm против golden-векторов", () => {
  type Transcript = {
    steps: Array<{ entry: unknown; headAfter: unknown }>;
    consistencyProofs: Array<{
      oldSize: number;
      newSize: number;
      oldRootHex: string;
      newRootHex: string;
      proofHex: string[];
    }>;
    inclusionProofs: Array<{ seq: number; treeSize: number; proofHex: string[] }>;
    cosigns: Array<{ cosign: unknown }>;
  };
  type Negative = {
    replayCases: Array<{ name: string; entries: unknown[]; expectedError: string }>;
  };

  async function verifier(): Promise<FepWasmVerifier> {
    return FepWasmVerifier.instantiate(readFileSync(artifact!));
  }

  const transcript = loadVector<Transcript>("fep-ledger-transcript-v1.json");
  const entries = transcript.steps.map((s) => parseLedgerEntry(s.entry));
  const finalHead = parseLedgerHead(transcript.steps[transcript.steps.length - 1]!.headAfter);

  it("полный реплей транскрипта ядром воспроизводит финальный head", async () => {
    const wasm = await verifier();
    const verdict = wasm.replay(entries);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.head).toEqual(finalHead);
      expect(verdict.summary.entries).toBe(finalHead.size);
      expect(verdict.summary.accounts).toBe(2);
      expect(verdict.summary.totalIssuedGrains).toBe(1_000_000_000n);
    }
  });

  it("экономическая подделка (inflated UBI) ловится движком — L2 сильнее L1", async () => {
    const wasm = await verifier();
    const negative = loadVector<Negative>("fep-ledger-negative-v1.json");
    for (const c of negative.replayCases) {
      const verdict = wasm.replay(c.entries.map(parseLedgerEntry));
      expect(verdict.ok, c.name).toBe(false);
      if (!verdict.ok) {
        expect(verdict.seq, c.name).toBe(3);
        expect(verdict.error.length).toBeGreaterThan(0);
      }
    }
  });

  it("entryHash ядра совпадает с TS-реализацией на всех записях", async () => {
    const wasm = await verifier();
    for (const entry of entries) {
      expect(toHex(wasm.entryHash(entry))).toBe(toHex(entryHash(entry)));
    }
  });

  it("inclusion/consistency-доказательства вектора проверяются ядром", async () => {
    const wasm = await verifier();
    for (const proof of transcript.inclusionProofs) {
      expect(
        wasm.verifyInclusion({
          leaf: merkleLeafHash(entryHash(entries[proof.seq]!)),
          index: proof.seq,
          treeSize: proof.treeSize,
          proof: proof.proofHex.map((h) => fromHex(h, 32)),
          root: fromHex(finalHead.merkleRoot, 32),
        }),
        `seq=${proof.seq}`,
      ).toBe(true);
    }
    for (const proof of transcript.consistencyProofs) {
      expect(
        wasm.verifyConsistency({
          oldSize: proof.oldSize,
          newSize: proof.newSize,
          oldRoot: fromHex(proof.oldRootHex, 32),
          newRoot: fromHex(proof.newRootHex, 32),
          proof: proof.proofHex.map((h) => fromHex(h, 32)),
        }),
        `${proof.oldSize}->${proof.newSize}`,
      ).toBe(true);
    }
  });

  it("косайны вектора проверяются ядром; подделка отвергается", async () => {
    const wasm = await verifier();
    for (const { cosign } of transcript.cosigns) {
      expect(wasm.verifyCosign(cosign)).toBe(true);
    }
    const tampered = structuredClone(transcript.cosigns[0]!.cosign) as { witness: string };
    tampered.witness = toHex(new Uint8Array(32).fill(0x13));
    expect(wasm.verifyCosign(tampered)).toBe(false);
  });
});
