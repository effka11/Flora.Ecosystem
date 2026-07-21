/**
 * Юнит-тесты валютного слоя LIV: краевые случаи, не покрытые golden-векторами
 * (паритет с ядром — fepVectors.test.ts). Синтетический журнал строится без
 * экономических операций (accountOpened не требует подписи) — реплей хеш-цепочки
 * проверяем целиком на TS-примитивах.
 */

import { describe, expect, it } from "vitest";

import { formatLiv, GRAINS_MAX, GRAINS_MIN, parseLiv } from "./amounts.js";
import { CanonicalWriter } from "./canonical.js";
import { EconomyCodecError, bytesEqual, compareBytes, fromHex, toHex, tryFromHex } from "./encoding.js";
import { zeroHash } from "./hash.js";
import {
  accountBytesFromUuid,
  entryHash,
  parseLedgerEntry,
  uuidFromAccountBytes,
  type EconomyParametersJson,
  type LedgerEntryJson,
} from "./ledger.js";
import { advanceTrustedHead, replayHashChain } from "./lightClient.js";
import { merkleLeafHash, merkleNodeHash, merkleRoot, verifyInclusion } from "./merkle.js";
import { publicKeyFromSeed, signDomainTagged, verifyDomainTagged } from "./sign.js";
import {
  authorizeCreditTransfer,
  authorizeTransfer,
  canonicalPairUuids,
  generateNonce,
  generateWalletSeed,
  ownerKeyHexFromSeed,
  signTrustline,
} from "./wallet.js";
import { cosignHead, isRegisteredWitness, verifyHeadCosign } from "./witness.js";

const PARAMS: EconomyParametersJson = {
  demurrage_ppm_per_period: 191,
  demurrage_period_ms: 86_400_000,
  demurrage_exempt_threshold: 100_000_000,
  ubi_per_epoch: 1_000_000_000,
  ubi_epoch_ms: 2_592_000_000,
  ubi_max_backfill_epochs: 3,
  trustline_max_limit: 5_000_000_000,
  credit_path_max_hops: 4,
};

/** Синтетический журнал: genesis + n открытий аккаунтов (без подписей). */
function journal(accounts: number): LedgerEntryJson[] {
  const entries: LedgerEntryJson[] = [];
  let prev = toHex(zeroHash());
  const push = (body: LedgerEntryJson["body"], at: number): void => {
    const entry: LedgerEntryJson = { seq: entries.length, at, prevHash: prev, body };
    prev = toHex(entryHash(entry));
    entries.push(entry);
  };
  push({ kind: "genesis", protocolVersion: 1, params: PARAMS }, 1_700_000_000_000);
  for (let i = 0; i < accounts; i += 1) {
    push(
      {
        kind: "accountOpened",
        account: Array.from({ length: 16 }, () => i + 1),
        ownerKey: ownerKeyHexFromSeed(new Uint8Array(32).fill(i + 1)),
      },
      1_700_000_000_000 + (i + 1) * 1000,
    );
  }
  return entries;
}

describe("amounts: краевые случаи диапазона i64", () => {
  it("границы i64 форматируются и парсятся, выход за границы отвергается", () => {
    expect(formatLiv(GRAINS_MAX)).toBe("9223372036854.775807");
    expect(formatLiv(GRAINS_MIN)).toBe("-9223372036854.775808");
    expect(parseLiv("9223372036854.775807")).toBe(GRAINS_MAX);
    expect(parseLiv("-9223372036854.775808")).toBe(GRAINS_MIN);
    expect(parseLiv("9223372036854.775808")).toBeNull();
    expect(parseLiv("-9223372036854.775809")).toBeNull();
    expect(() => formatLiv(GRAINS_MAX + 1n)).toThrow(RangeError);
  });

  it("roundtrip формата на характерных значениях", () => {
    for (const grains of [0n, 1n, -1n, 999_999n, 1_000_000n, -42_000_000n, 123_456_789n]) {
      expect(parseLiv(formatLiv(grains))).toBe(grains);
    }
  });
});

describe("encoding: hex и сравнения", () => {
  it("fromHex принимает оба регистра, отвергает мусор", () => {
    expect(toHex(fromHex("00ffAB"))).toBe("00ffab");
    expect(tryFromHex("0g")).toBeNull();
    expect(tryFromHex("abc")).toBeNull();
    expect(() => fromHex("aabb", 3)).toThrow(EconomyCodecError);
  });

  it("compareBytes задаёт канонический порядок пар", () => {
    expect(compareBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBeLessThan(0);
    expect(compareBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(0);
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(1, 0))).toBe(false);
  });
});

describe("canonical writer: детерминизм и диапазоны", () => {
  it("big-endian фиксированной ширины и префиксы длины", () => {
    const bytes = new CanonicalWriter()
      .u8(0xab)
      .u16(0x0102)
      .u32(0x01020304)
      .u64(0x0102030405060708n)
      .i64(-1n)
      .bytes(Uint8Array.of(0xaa, 0xbb))
      .finish();
    expect(toHex(bytes)).toBe(
      "ab" + "0102" + "01020304" + "0102030405060708" + "ffffffffffffffff" + "00000002aabb",
    );
  });

  it("выход за диапазон — ошибка кодека, не тихое усечение", () => {
    expect(() => new CanonicalWriter().u8(256)).toThrow(EconomyCodecError);
    expect(() => new CanonicalWriter().u64(-1n)).toThrow(EconomyCodecError);
    expect(() => new CanonicalWriter().i64(2n ** 63n)).toThrow(EconomyCodecError);
    expect(() => new CanonicalWriter().hash32(new Uint8Array(31))).toThrow(EconomyCodecError);
    expect(() => new CanonicalWriter().account(new Uint8Array(15))).toThrow(EconomyCodecError);
  });
});

describe("аккаунты: UUID ↔ байты", () => {
  it("roundtrip и канонический порядок пары", () => {
    const a = "0102030405060708090a0b0c0d0e0f10";
    const hyphenated = "01020304-0506-0708-090a-0b0c0d0e0f10";
    expect(uuidFromAccountBytes(accountBytesFromUuid(a))).toBe(hyphenated);
    expect(uuidFromAccountBytes(accountBytesFromUuid(hyphenated.toUpperCase()))).toBe(hyphenated);
    const b = "fffefdfc-fbfa-f9f8-f7f6-f5f4f3f2f1f0";
    expect(canonicalPairUuids(b, hyphenated)).toEqual([hyphenated, b]);
    expect(() => accountBytesFromUuid("не-uuid")).toThrow(EconomyCodecError);
  });
});

describe("подписи: доменное разделение и строгая верификация", () => {
  const seed = new Uint8Array(32).fill(7);
  const payload = Uint8Array.of(1, 2, 3);

  it("подпись под одной меткой не проходит под другой", () => {
    const signature = signDomainTagged("flora/economy/v1/transfer/auth", payload, seed);
    const publicKey = publicKeyFromSeed(seed);
    expect(verifyDomainTagged("flora/economy/v1/transfer/auth", payload, signature, publicKey)).toBe(true);
    expect(verifyDomainTagged("flora/economy/v1/trustline/auth", payload, signature, publicKey)).toBe(false);
  });

  it("мусорные ключи и подписи — false, не исключение", () => {
    const signature = signDomainTagged("t", payload, seed);
    expect(verifyDomainTagged("t", payload, signature.slice(0, 63), publicKeyFromSeed(seed))).toBe(false);
    expect(verifyDomainTagged("t", payload, signature, new Uint8Array(32))).toBe(false);
  });
});

describe("кошелёк: CSPRNG и авторизация", () => {
  it("seed/nonce корректной длины и не повторяются", () => {
    expect(generateWalletSeed()).toHaveLength(32);
    expect(generateNonce()).toHaveLength(16);
    expect(toHex(generateNonce())).not.toBe(toHex(generateNonce()));
  });

  it("трастлайн подписывается только в каноническом порядке пары", () => {
    const lo = "01020304-0506-0708-090a-0b0c0d0e0f10";
    const hi = "fffefdfc-fbfa-f9f8-f7f6-f5f4f3f2f1f0";
    const seed = generateWalletSeed();
    expect(() =>
      signTrustline({
        seed,
        loUuid: hi,
        hiUuid: lo,
        limitLoToHiGrains: 1n,
        limitHiToLoGrains: 0n,
      }),
    ).toThrow(/канонич/);
    const signature = signTrustline({
      seed,
      loUuid: lo,
      hiUuid: hi,
      limitLoToHiGrains: 1n,
      limitHiToLoGrains: 0n,
    });
    expect(signature).toHaveLength(128);
  });

  it("платёж по цепочке подписывается плательщиком и содержит копию пути", () => {
    const path = [
      "01020304-0506-0708-090a-0b0c0d0e0f10",
      "fffefdfc-fbfa-f9f8-f7f6-f5f4f3f2f1f0",
    ];
    const signed = authorizeCreditTransfer({
      seed: generateWalletSeed(),
      pathUuids: path,
      amountGrains: 5n,
    });
    expect(signed.pathUuids).toEqual(path);
    expect(signed.pathUuids).not.toBe(path);
    expect(signed.signatureHex).toHaveLength(128);
  });
});

describe("реплей хеш-цепочки и Merkle", () => {
  it("валидный журнал реплеится; порча любой записи ловится", () => {
    const entries = journal(4);
    const replay = replayHashChain(entries);
    expect(replay.ok).toBe(true);

    const tampered = structuredClone(entries);
    const body = tampered[2]!.body;
    if (body.kind === "accountOpened") body.ownerKey = toHex(new Uint8Array(32).fill(0xee));
    const broken = replayHashChain(tampered);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.seq).toBe(3); // разрыв виден на следующей записи

    expect(replayHashChain([]).ok).toBe(false);
  });

  it("merkleRoot + inclusion согласованы на синтетических листьях", () => {
    const leaves = journal(6).map((e) => merkleLeafHash(entryHash(e)));
    const root = merkleRoot(leaves);
    expect(merkleNodeHash(leaves[0]!, leaves[1]!)).not.toEqual(root);
    // Построение доказательств — задача сервера; юнит проверяет вырожденные случаи.
    expect(verifyInclusion(leaves[0]!, 0, 1, [], leaves[0]!)).toBe(true);
    expect(verifyInclusion(leaves[0]!, 0, 1, [leaves[1]!], leaves[0]!)).toBe(false);
    expect(verifyInclusion(leaves[0]!, 2, 1, [], leaves[0]!)).toBe(false);
  });
});

describe("лёгкий клиент: правила продвижения head", () => {
  const entries = journal(3);
  const full = replayHashChain(entries);
  const prefix = replayHashChain(entries.slice(0, 2));
  if (!full.ok || !prefix.ok) throw new Error("синтетический журнал валиден");

  it("TOFU, сжатие и подмена при том же размере", () => {
    expect(advanceTrustedHead({ trusted: null, offered: full.head }).ok).toBe(true);

    const shrink = advanceTrustedHead({ trusted: full.head, offered: prefix.head });
    expect(shrink.ok).toBe(false);
    if (!shrink.ok) expect(shrink.reason).toBe("size_regression");

    const forged = { ...full.head, merkleRoot: toHex(new Uint8Array(32).fill(1)) };
    const fork = advanceTrustedHead({ trusted: full.head, offered: forged });
    expect(fork.ok).toBe(false);
    if (!fork.ok) expect(fork.reason).toBe("same_size_different_head");

    const unchanged = advanceTrustedHead({ trusted: full.head, offered: full.head });
    expect(unchanged.ok).toBe(true);
  });

  it("косайны: свой реестр обязателен, чужой витнесс не учитывается", () => {
    const witnessSeed = new Uint8Array(32).fill(0x77);
    const strangerSeed = new Uint8Array(32).fill(0x66);
    const cosign = cosignHead(full.head, witnessSeed);
    const stranger = cosignHead(full.head, strangerSeed);
    expect(verifyHeadCosign(cosign)).toBe(true);
    expect(isRegisteredWitness(cosign, [toHex(publicKeyFromSeed(witnessSeed))])).toBe(true);

    const result = advanceTrustedHead({
      trusted: null,
      offered: full.head,
      cosigns: [cosign, stranger],
      witnessesHex: [toHex(publicKeyFromSeed(witnessSeed))],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirmedCosigns).toBe(1);
      expect(result.staleCosigns).toBe(0);
    }
  });
});

describe("разбор записей с границы: жёсткий отказ", () => {
  it("неизвестный вид записи и битые поля отвергаются", () => {
    expect(() =>
      parseLedgerEntry({
        seq: 0,
        at: 1,
        prevHash: toHex(zeroHash()),
        body: { kind: "quantumAirdrop" },
      }),
    ).toThrow(EconomyCodecError);
    expect(() =>
      parseLedgerEntry({
        seq: 0.5,
        at: 1,
        prevHash: toHex(zeroHash()),
        body: { kind: "genesis", protocolVersion: 1, params: PARAMS },
      }),
    ).toThrow(EconomyCodecError);
  });

  it("сквозной пример: authorizeTransfer производит верифицируемые поля", () => {
    const seed = generateWalletSeed();
    const from = "01020304-0506-0708-090a-0b0c0d0e0f10";
    const to = "fffefdfc-fbfa-f9f8-f7f6-f5f4f3f2f1f0";
    const signed = authorizeTransfer({ seed, fromUuid: from, toUuid: to, amountGrains: 42n });
    expect(signed.nonceHex).toHaveLength(32);
    expect(signed.signatureHex).toHaveLength(128);
    expect(signed.amountGrains).toBe(42n);
  });
});
