/**
 * Типизированный клиент HTTP API экономики (`/api/economy/*`, LIV.md §6).
 *
 * Транспорт — общий API-клиент пакета (JWT, ретраи, обработка 401). Ответы проходят
 * строгий разбор на границе (суммы — только безопасные целые, hex — валидируется),
 * чтобы искажённый ответ сервера падал громко, а не тихо портил проверки.
 */

import { authGetJson, authPostJson } from "../api/client.js";
import { EconomyCodecError, grainsFromJsonNumber, grainsToJsonNumber } from "./encoding.js";
import {
  parseLedgerEntry,
  parseLedgerHead,
  type EconomyParametersJson,
  type LedgerEntryJson,
  type LedgerHeadJson,
} from "./ledger.js";
import { parseHeadCosign, type HeadCosignJson } from "./witness.js";
import type { SignedCreditTransfer, SignedTransfer } from "./wallet.js";

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EconomyCodecError(`${what}: ожидался JSON-объект`);
  }
  return value as Record<string, unknown>;
}

function readSafeInt(o: Record<string, unknown>, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new EconomyCodecError(`${what}.${key}: ожидалось целое число`);
  }
  return v;
}

function readStr(o: Record<string, unknown>, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== "string") {
    throw new EconomyCodecError(`${what}.${key}: ожидалась строка`);
  }
  return v;
}

/** Экономические параметры сети (snake_case — контракт ядра). */
export async function apiEconomyParameters(): Promise<EconomyParametersJson> {
  const raw = asRecord(await authGetJson("/api/economy/parameters"), "parameters");
  return raw as EconomyParametersJson;
}

/** Сводка Commons-казны. */
export async function apiEconomyCommons(): Promise<{
  balanceGrains: bigint;
  totalIssuedGrains: bigint;
}> {
  const o = asRecord(await authGetJson("/api/economy/commons"), "commons");
  return {
    balanceGrains: grainsFromJsonNumber(o.balanceGrains),
    totalIssuedGrains: grainsFromJsonNumber(o.totalIssuedGrains),
  };
}

/** Текущий head журнала. */
export async function apiEconomyHead(): Promise<LedgerHeadJson> {
  return parseLedgerHead(await authGetJson("/api/economy/ledger/head"));
}

/** STH: head + реестр витнессов + свежие косайны (вход для L1-проверки). */
export type EconomySth = {
  head: LedgerHeadJson;
  witnesses: string[];
  cosigns: HeadCosignJson[];
};

export async function apiEconomySth(): Promise<EconomySth> {
  const o = asRecord(await authGetJson("/api/economy/ledger/sth"), "sth");
  const witnessesRaw = o.witnesses;
  const cosignsRaw = o.cosigns;
  if (!Array.isArray(witnessesRaw) || !Array.isArray(cosignsRaw)) {
    throw new EconomyCodecError("sth: witnesses/cosigns обязаны быть массивами");
  }
  return {
    head: parseLedgerHead(o.head),
    witnesses: witnessesRaw.map((w) => {
      if (typeof w !== "string") throw new EconomyCodecError("sth.witnesses: ожидались hex-строки");
      return w;
    }),
    cosigns: cosignsRaw.map(parseHeadCosign),
  };
}

/** Страница записей журнала начиная с `from` (для реплея хеш-цепочки / L2). */
export async function apiEconomyEntries(input?: {
  from?: number;
  limit?: number;
}): Promise<LedgerEntryJson[]> {
  const params = new URLSearchParams();
  if (input?.from !== undefined) params.set("from", String(input.from));
  if (input?.limit !== undefined) params.set("limit", String(input.limit));
  const qs = params.toString();
  const q = qs.length > 0 ? `?${qs}` : "";
  const raw = await authGetJson(`/api/economy/ledger/entries${q}`);
  if (!Array.isArray(raw)) {
    throw new EconomyCodecError("entries: ожидался массив записей");
  }
  return raw.map(parseLedgerEntry);
}

/** Inclusion-доказательство записи `seq` против текущего head (L0). */
export async function apiEconomyProof(seq: number): Promise<{
  seq: number;
  proof: string[];
  head: LedgerHeadJson;
}> {
  const o = asRecord(await authGetJson(`/api/economy/ledger/proof/${seq}`), "proof");
  const proofRaw = o.proof;
  if (!Array.isArray(proofRaw)) throw new EconomyCodecError("proof.proof: ожидался массив");
  return {
    seq: readSafeInt(o, "seq", "proof"),
    proof: proofRaw.map((p) => {
      if (typeof p !== "string") throw new EconomyCodecError("proof.proof: ожидались hex-строки");
      return p;
    }),
    head: parseLedgerHead(o.head),
  };
}

/** Consistency-доказательство `oldSize → newSize` (по умолчанию — до текущего head, L1). */
export async function apiEconomyConsistency(input: {
  oldSize: number;
  newSize?: number;
}): Promise<{
  oldSize: number;
  newSize: number;
  oldRoot: string;
  newRoot: string;
  proof: string[];
  head: LedgerHeadJson;
}> {
  const params = new URLSearchParams({ oldSize: String(input.oldSize) });
  if (input.newSize !== undefined) params.set("newSize", String(input.newSize));
  const o = asRecord(await authGetJson(`/api/economy/ledger/consistency?${params}`), "consistency");
  const proofRaw = o.proof;
  if (!Array.isArray(proofRaw)) throw new EconomyCodecError("consistency.proof: ожидался массив");
  return {
    oldSize: readSafeInt(o, "oldSize", "consistency"),
    newSize: readSafeInt(o, "newSize", "consistency"),
    oldRoot: readStr(o, "oldRoot", "consistency"),
    newRoot: readStr(o, "newRoot", "consistency"),
    proof: proofRaw.map((p) => {
      if (typeof p !== "string") {
        throw new EconomyCodecError("consistency.proof: ожидались hex-строки");
      }
      return p;
    }),
    head: parseLedgerHead(o.head),
  };
}

/** Сводка экономического аккаунта. */
export type EconomyAccountSummary = {
  accountUuid: string;
  balanceGrains: bigint;
  lastUbiEpoch: number | null;
  demurrageAppliedAtMs: number;
};

function parseAccountSummary(value: unknown): EconomyAccountSummary {
  const o = asRecord(value, "account");
  const lastUbiEpochRaw = o.lastUbiEpoch;
  return {
    accountUuid: readStr(o, "accountUuid", "account"),
    balanceGrains: grainsFromJsonNumber(o.balanceGrains),
    lastUbiEpoch:
      lastUbiEpochRaw === null || lastUbiEpochRaw === undefined
        ? null
        : readSafeInt(o, "lastUbiEpoch", "account"),
    demurrageAppliedAtMs: readSafeInt(o, "demurrageAppliedAtMs", "account"),
  };
}

export async function apiEconomyAccount(accountUuid: string): Promise<EconomyAccountSummary> {
  return parseAccountSummary(
    await authGetJson(`/api/economy/accounts/${encodeURIComponent(accountUuid)}`),
  );
}

/** Открыть экономический аккаунт: UUID пользователя + публичный ключ владения. */
export async function apiEconomyOpenAccount(input: {
  accountUuid: string;
  ownerKeyHex: string;
}): Promise<EconomyAccountSummary> {
  return parseAccountSummary(
    await authPostJson("/api/economy/accounts", {
      accountUuid: input.accountUuid,
      ownerKeyHex: input.ownerKeyHex,
    }),
  );
}

/** Результат применения команды: позиция записи в журнале. */
export type EconomyApplied = {
  seq: number;
  entryHash: string;
  atMs: number;
};

function parseApplied(value: unknown): EconomyApplied {
  const o = asRecord(value, "applied");
  return {
    seq: readSafeInt(o, "seq", "applied"),
    entryHash: readStr(o, "entryHash", "applied"),
    atMs: readSafeInt(o, "atMs", "applied"),
  };
}

/** Начислить UBI за пропущенные эпохи (сервер проверяет personhood-аттестацию). */
export async function apiEconomyClaimUbi(accountUuid: string): Promise<EconomyApplied> {
  return parseApplied(await authPostJson("/api/economy/ubi/claims", { accountUuid }));
}

/** Отправить подписанный кошельком перевод (см. `authorizeTransfer`). */
export async function apiEconomySubmitTransfer(signed: SignedTransfer): Promise<EconomyApplied> {
  return parseApplied(
    await authPostJson("/api/economy/transfers", {
      fromUuid: signed.fromUuid,
      toUuid: signed.toUuid,
      amountGrains: grainsToJsonNumber(signed.amountGrains),
      nonceHex: signed.nonceHex,
      signatureHex: signed.signatureHex,
    }),
  );
}

/** Установить линию доверия (обе подписи — см. `signTrustline`). */
export async function apiEconomySubmitTrustline(input: {
  loUuid: string;
  hiUuid: string;
  limitLoToHiGrains: bigint;
  limitHiToLoGrains: bigint;
  signatureLoHex: string;
  signatureHiHex: string;
}): Promise<EconomyApplied> {
  return parseApplied(
    await authPostJson("/api/economy/trustlines", {
      loUuid: input.loUuid,
      hiUuid: input.hiUuid,
      limitLoToHiGrains: grainsToJsonNumber(input.limitLoToHiGrains),
      limitHiToLoGrains: grainsToJsonNumber(input.limitHiToLoGrains),
      signatureLoHex: input.signatureLoHex,
      signatureHiHex: input.signatureHiHex,
    }),
  );
}

/** Отправить платёж по цепочке доверия (см. `authorizeCreditTransfer`). */
export async function apiEconomySubmitCreditTransfer(
  signed: SignedCreditTransfer,
): Promise<EconomyApplied> {
  return parseApplied(
    await authPostJson("/api/economy/credit-transfers", {
      pathUuids: signed.pathUuids,
      amountGrains: grainsToJsonNumber(signed.amountGrains),
      nonceHex: signed.nonceHex,
      signatureHex: signed.signatureHex,
    }),
  );
}
