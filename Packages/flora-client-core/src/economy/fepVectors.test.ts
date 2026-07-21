/**
 * Consumer-тесты golden-векторов FEP (Documents/test-vectors/fep/, LIV.md Приложение):
 * бит-в-бит паритет TS-слоя с эталонным Rust-ядром `flora-economy-crypto`.
 * Файлы Documents/test-vectors/** — regenerate-only, руками не редактировать.
 *
 * Ed25519 детерминирован (RFC 8032), поэтому проверяется равенство и подписей:
 * TS-кошелёк обязан производить те же байты, что и ядро.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { formatLiv, parseLiv } from "./amounts.js";
import {
  FEP_CREDIT_TRANSFER_AUTH,
  FEP_LEDGER_LEAF,
  FEP_LEDGER_STH,
  FEP_MERKLE_LEAF,
  FEP_MERKLE_NODE,
  FEP_TRANSFER_AUTH,
  FEP_TRUSTLINE_AUTH,
} from "./domainTags.js";
import { fromHex, toHex, utf8Bytes } from "./encoding.js";
import { sha256Tagged } from "./hash.js";
import {
  accountBytesFromJson,
  creditTransferSigningBytes,
  entryHash,
  headCanonicalBytes,
  parseLedgerEntry,
  parseLedgerHead,
  transferSigningBytes,
  trustlineSigningBytes,
  type LedgerEntryJson,
  type LedgerHeadJson,
  uuidFromAccountBytes,
} from "./ledger.js";
import {
  advanceTrustedHead,
  replayHashChain,
  verifyEntryInclusion,
} from "./lightClient.js";
import { merkleLeafHash, verifyConsistency, verifyInclusion } from "./merkle.js";
import { publicKeyFromSeed, signDomainTagged, verifyDomainTagged } from "./sign.js";
import { authorizeTransfer } from "./wallet.js";
import { parseHeadCosign, verifyHeadCosign, type HeadCosignJson } from "./witness.js";

const vectorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "Documents", "test-vectors", "fep",
);

function vectorText(name: string): string {
  return readFileSync(path.join(vectorsDir, name), "utf8");
}

function loadVector<T>(name: string): T {
  return JSON.parse(vectorText(name)) as T;
}

// ---------- fep-domain-tags-v1 ----------

describe("golden: fep-domain-tags-v1.json", () => {
  type TagsVector = {
    taggedMaterialHex: string;
    tags: Array<{ name: string; tag: string; tagBytesHex: string; sha256TaggedHex: string }>;
  };
  const v = loadVector<TagsVector>("fep-domain-tags-v1.json");
  const constants: Record<string, string> = {
    LEDGER_LEAF: FEP_LEDGER_LEAF,
    LEDGER_STH: FEP_LEDGER_STH,
    MERKLE_LEAF: FEP_MERKLE_LEAF,
    MERKLE_NODE: FEP_MERKLE_NODE,
    TRANSFER_AUTH: FEP_TRANSFER_AUTH,
    TRUSTLINE_AUTH: FEP_TRUSTLINE_AUTH,
    CREDIT_TRANSFER_AUTH: FEP_CREDIT_TRANSFER_AUTH,
  };

  it("реестр меток совпадает с TS-константами байт-в-байт", () => {
    expect(v.tags).toHaveLength(Object.keys(constants).length);
    for (const tag of v.tags) {
      expect(constants[tag.name], tag.name).toBe(tag.tag);
      expect(toHex(utf8Bytes(tag.tag))).toBe(tag.tagBytesHex);
    }
  });

  it("tagged SHA-256 воспроизводится над эталонным материалом", () => {
    const material = fromHex(v.taggedMaterialHex);
    for (const tag of v.tags) {
      expect(toHex(sha256Tagged(tag.tag, material)), tag.name).toBe(tag.sha256TaggedHex);
    }
  });
});

// ---------- fep-liv-amounts-v1 ----------

describe("golden: fep-liv-amounts-v1.json", () => {
  // JSON.parse теряет точность выше 2^53 − 1, а вектор содержит i64::MAX/MIN —
  // пары значений извлекаются из исходного текста с bigint-точностью.
  const text = vectorText("fep-liv-amounts-v1.json");

  function section(name: string): string {
    const start = text.indexOf(`"${name}"`);
    expect(start, `секция ${name}`).toBeGreaterThan(0);
    const end = text.indexOf("]", start);
    return text.slice(start, end);
  }

  it("канонический формат сумм воспроизводится (включая i64::MAX/MIN)", () => {
    const cases = [...section("format").matchAll(/"grains":\s*(-?\d+),\s*"liv":\s*"([^"]*)"/g)];
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const [, grains, liv] of cases) {
      expect(formatLiv(BigInt(grains!))).toBe(liv!);
    }
  });

  it("разбор канонических и сокращённых записей совпадает", () => {
    const cases = [...section("parse").matchAll(/"input":\s*"([^"]*)",\s*"grains":\s*(-?\d+)/g)];
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const [, input, grains] of cases) {
      expect(parseLiv(input!), input).toBe(BigInt(grains!));
    }
  });

  it("мусорные формы отклоняются", () => {
    const v = loadVector<{ parseRejects: Array<{ input: string }> }>("fep-liv-amounts-v1.json");
    expect(v.parseRejects.length).toBeGreaterThanOrEqual(10);
    for (const reject of v.parseRejects) {
      expect(parseLiv(reject.input), JSON.stringify(reject.input)).toBeNull();
    }
  });
});

// ---------- fep-ledger-transcript-v1 ----------

type TranscriptVector = {
  seeds: Record<string, string>;
  witnessPublicKeyHex: string;
  steps: Array<{
    entry: unknown;
    entryHashHex: string;
    headAfter: unknown;
    aux: {
      ownerSeedHex?: string;
      domainTag?: string;
      signingPayloadHex?: string;
    } | null;
  }>;
  inclusionProofs: Array<{
    seq: number;
    treeSize: number;
    leafHashHex: string;
    proofHex: string[];
  }>;
  consistencyProofs: Array<{
    oldSize: number;
    newSize: number;
    oldRootHex: string;
    newRootHex: string;
    proofHex: string[];
  }>;
  cosigns: Array<{
    cosign: unknown;
    sthCanonicalBytesHex: string;
    domainTag: string;
  }>;
};

describe("golden: fep-ledger-transcript-v1.json", () => {
  const v = loadVector<TranscriptVector>("fep-ledger-transcript-v1.json");
  const entries: LedgerEntryJson[] = v.steps.map((s) => parseLedgerEntry(s.entry));
  const heads: LedgerHeadJson[] = v.steps.map((s) => parseLedgerHead(s.headAfter));
  const finalHead = heads[heads.length - 1]!;

  // Ключи владения из журнала: accountOpened → (account → seed из aux).
  const ownerSeeds = new Map<string, string>();
  for (let i = 0; i < entries.length; i += 1) {
    const body = entries[i]!.body;
    if (body.kind === "accountOpened") {
      ownerSeeds.set(toHex(accountBytesFromJson(body.account)), v.steps[i]!.aux!.ownerSeedHex!);
    }
  }
  const seedOf = (account: number[]): Uint8Array => {
    const seed = ownerSeeds.get(toHex(accountBytesFromJson(account)));
    expect(seed, "владелец аккаунта известен из журнала").toBeDefined();
    return fromHex(seed!, 32);
  };

  it("хеш каждой записи воспроизводится байт-в-байт", () => {
    for (let i = 0; i < entries.length; i += 1) {
      expect(toHex(entryHash(entries[i]!)), `seq=${i}`).toBe(v.steps[i]!.entryHashHex);
    }
  });

  it("реплей хеш-цепочки воспроизводит head каждого шага", () => {
    for (let i = 0; i < entries.length; i += 1) {
      const replay = replayHashChain(entries.slice(0, i + 1));
      expect(replay.ok, `seq=${i}`).toBe(true);
      if (replay.ok) {
        expect(replay.head, `seq=${i}`).toEqual(heads[i]!);
      }
    }
  });

  it("ключи владения выводятся из seed-ов (accountOpened)", () => {
    for (const entry of entries) {
      if (entry.body.kind !== "accountOpened") continue;
      const seed = seedOf(entry.body.account);
      expect(toHex(publicKeyFromSeed(seed))).toBe(entry.body.ownerKey);
    }
  });

  it("подписываемые байты и детерминированные подписи транзакций совпадают", () => {
    for (let i = 0; i < entries.length; i += 1) {
      const body = entries[i]!.body;
      const aux = v.steps[i]!.aux;
      if (body.kind === "transfer") {
        const payload = transferSigningBytes(
          accountBytesFromJson(body.from),
          accountBytesFromJson(body.to),
          BigInt(body.amount),
          fromHex(body.nonce, 16),
        );
        expect(aux?.domainTag).toBe(FEP_TRANSFER_AUTH);
        expect(toHex(payload)).toBe(aux!.signingPayloadHex!);
        const seed = seedOf(body.from);
        expect(toHex(signDomainTagged(FEP_TRANSFER_AUTH, payload, seed))).toBe(body.signature);
        expect(
          verifyDomainTagged(
            FEP_TRANSFER_AUTH,
            payload,
            fromHex(body.signature, 64),
            publicKeyFromSeed(seed),
          ),
        ).toBe(true);
      }
      if (body.kind === "trustlineSet") {
        const payload = trustlineSigningBytes(
          accountBytesFromJson(body.lo),
          accountBytesFromJson(body.hi),
          BigInt(body.limitLoToHi),
          BigInt(body.limitHiToLo),
        );
        expect(aux?.domainTag).toBe(FEP_TRUSTLINE_AUTH);
        expect(toHex(payload)).toBe(aux!.signingPayloadHex!);
        expect(toHex(signDomainTagged(FEP_TRUSTLINE_AUTH, payload, seedOf(body.lo)))).toBe(
          body.signatureLo,
        );
        expect(toHex(signDomainTagged(FEP_TRUSTLINE_AUTH, payload, seedOf(body.hi)))).toBe(
          body.signatureHi,
        );
      }
      if (body.kind === "creditTransfer") {
        const payload = creditTransferSigningBytes(
          body.path.map(accountBytesFromJson),
          BigInt(body.amount),
          fromHex(body.nonce, 16),
        );
        expect(aux?.domainTag).toBe(FEP_CREDIT_TRANSFER_AUTH);
        expect(toHex(payload)).toBe(aux!.signingPayloadHex!);
        expect(
          toHex(signDomainTagged(FEP_CREDIT_TRANSFER_AUTH, payload, seedOf(body.path[0]!))),
        ).toBe(body.signature);
      }
    }
  });

  it("кошелёк end-to-end воспроизводит подпись перевода из журнала", () => {
    const transfer = entries.find((e) => e.body.kind === "transfer");
    expect(transfer).toBeDefined();
    const body = transfer!.body;
    if (body.kind !== "transfer") return;
    const signed = authorizeTransfer({
      seed: seedOf(body.from),
      fromUuid: uuidFromAccountBytes(accountBytesFromJson(body.from)),
      toUuid: uuidFromAccountBytes(accountBytesFromJson(body.to)),
      amountGrains: BigInt(body.amount),
      nonce: fromHex(body.nonce, 16),
    });
    expect(signed.signatureHex).toBe(body.signature);
    expect(signed.nonceHex).toBe(body.nonce);
  });

  it("косайны витнесса: канонические байты, подпись, детерминированное переподписание", () => {
    expect(v.cosigns.length).toBeGreaterThanOrEqual(2);
    const witnessSeed = fromHex(v.seeds.witnessHex!, 32);
    expect(toHex(publicKeyFromSeed(witnessSeed))).toBe(v.witnessPublicKeyHex);
    for (const entry of v.cosigns) {
      const cosign: HeadCosignJson = parseHeadCosign(entry.cosign);
      expect(entry.domainTag).toBe(FEP_LEDGER_STH);
      expect(toHex(headCanonicalBytes(cosign.head))).toBe(entry.sthCanonicalBytesHex);
      expect(verifyHeadCosign(cosign)).toBe(true);
      expect(toHex(signDomainTagged(FEP_LEDGER_STH, headCanonicalBytes(cosign.head), witnessSeed))).toBe(
        cosign.signature,
      );
    }
  });

  it("inclusion-доказательства проверяются против финального head (L0)", () => {
    expect(v.inclusionProofs.length).toBeGreaterThanOrEqual(3);
    for (const proof of v.inclusionProofs) {
      const entry = entries[proof.seq]!;
      expect(toHex(merkleLeafHash(entryHash(entry)))).toBe(proof.leafHashHex);
      expect(proof.treeSize).toBe(finalHead.size);
      expect(verifyEntryInclusion(entry, proof.proofHex, finalHead), `seq=${proof.seq}`).toBe(true);
      // Подмена листа отвергается.
      expect(
        verifyInclusion(
          merkleLeafHash(entryHash(entries[(proof.seq + 1) % entries.length]!)),
          proof.seq,
          proof.treeSize,
          proof.proofHex.map((h) => fromHex(h, 32)),
          fromHex(finalHead.merkleRoot, 32),
        ),
      ).toBe(false);
    }
  });

  it("consistency-доказательства проверяются (L1)", () => {
    expect(v.consistencyProofs.length).toBeGreaterThanOrEqual(3);
    for (const proof of v.consistencyProofs) {
      expect(
        verifyConsistency(
          proof.oldSize,
          proof.newSize,
          fromHex(proof.oldRootHex, 32),
          fromHex(proof.newRootHex, 32),
          proof.proofHex.map((h) => fromHex(h, 32)),
        ),
        `${proof.oldSize}->${proof.newSize}`,
      ).toBe(true);
    }
  });

  it("лёгкий клиент продвигает доверенный head по векторным доказательствам", () => {
    const growth = v.consistencyProofs.find((p) => p.oldSize === 4 && p.newSize === 10)!;
    const trusted = heads[3]!; // head после seq=3 (size 4)
    expect(trusted.merkleRoot).toBe(growth.oldRootHex);
    const cosigns = v.cosigns.map((c) => parseHeadCosign(c.cosign));
    const result = advanceTrustedHead({
      trusted,
      offered: finalHead,
      consistencyProofHex: growth.proofHex,
      cosigns,
      witnessesHex: [v.witnessPublicKeyHex],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Косайн size=10 подтверждает head, косайн size=4 — валидный, но устаревший.
      expect(result.confirmedCosigns).toBe(1);
      expect(result.staleCosigns).toBe(1);
    }

    // Без доказательства рост не принимается.
    const missing = advanceTrustedHead({ trusted, offered: finalHead });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toBe("missing_consistency_proof");
    }
  });
});

// ---------- fep-ledger-negative-v1 ----------

describe("golden: fep-ledger-negative-v1.json", () => {
  type NegativeVector = {
    replayCases: Array<{ name: string; entries: unknown[]; expectedError: string }>;
    consistencyCases: Array<{
      name: string;
      oldSize: number;
      newSize: number;
      oldRootHex: string;
      newRootHex: string;
      proofHex: string[];
      expectedError: string;
    }>;
    cosignCases: Array<{ name: string; cosign: unknown; expectedError: string }>;
  };
  const v = loadVector<NegativeVector>("fep-ledger-negative-v1.json");
  const caseByName = (name: string) => {
    const found = v.replayCases.find((c) => c.name === name);
    expect(found, name).toBeDefined();
    return found!;
  };

  it("transfer_bad_signature: подпись отвергается ключом владельца из журнала", () => {
    const entries = caseByName("transfer_bad_signature").entries.map(parseLedgerEntry);
    // Хеш-цепочка цела — подделка именно криптографическая.
    expect(replayHashChain(entries).ok).toBe(true);
    const transfer = entries.find((e) => e.body.kind === "transfer")!;
    const opened = entries.find(
      (e) =>
        e.body.kind === "accountOpened" &&
        transfer.body.kind === "transfer" &&
        toHex(accountBytesFromJson(e.body.account)) ===
          toHex(accountBytesFromJson(transfer.body.from)),
    )!;
    if (transfer.body.kind !== "transfer" || opened.body.kind !== "accountOpened") return;
    const payload = transferSigningBytes(
      accountBytesFromJson(transfer.body.from),
      accountBytesFromJson(transfer.body.to),
      BigInt(transfer.body.amount),
      fromHex(transfer.body.nonce, 16),
    );
    expect(
      verifyDomainTagged(
        FEP_TRANSFER_AUTH,
        payload,
        fromHex(transfer.body.signature, 64),
        fromHex(opened.body.ownerKey, 32),
      ),
    ).toBe(false);
  });

  it("broken_hash_chain: реплей хеш-цепочки указывает точку разрыва", () => {
    const entries = caseByName("broken_hash_chain").entries.map(parseLedgerEntry);
    const replay = replayHashChain(entries);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.seq).toBe(3);
    }
  });

  it("inflated_ubi_amount: хеш-цепочка цела — ловится только движком (L2/wasm)", () => {
    // Экономические инварианты вне компетенции L1: кейс обязан проходить хеш-проверку
    // и отвергаться детерминированным ядром (см. wasm.test.ts и Rust consumer-тесты).
    const entries = caseByName("inflated_ubi_amount").entries.map(parseLedgerEntry);
    expect(replayHashChain(entries).ok).toBe(true);
  });

  it("forked_prefix: consistency-доказательство форка не сходится", () => {
    for (const c of v.consistencyCases) {
      expect(
        verifyConsistency(
          c.oldSize,
          c.newSize,
          fromHex(c.oldRootHex, 32),
          fromHex(c.newRootHex, 32),
          c.proofHex.map((h) => fromHex(h, 32)),
        ),
        c.name,
      ).toBe(false);
    }
  });

  it("tampered_signature: косайн с подделанной подписью отвергается", () => {
    for (const c of v.cosignCases) {
      expect(verifyHeadCosign(parseHeadCosign(c.cosign)), c.name).toBe(false);
    }
  });
});
