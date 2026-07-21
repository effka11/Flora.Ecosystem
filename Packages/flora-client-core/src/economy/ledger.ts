/**
 * Журнал FEP на клиенте: типы JSON-представления (контракт JSONL-журнала и HTTP API),
 * канонические байты и хеши записей — зеркало `flora-economy-crypto::ledger`.
 *
 * JSON (camelCase, hex для байтовых полей, суммы — grain числом) — только транспорт;
 * в хеши входит **канонический бинарный формат** (FEP.md §9.3). Параметры протокола
 * сериализуются snake_case — как в Rust-ядре (контракт журнала).
 */

import { CanonicalWriter } from "./canonical.js";
import { FEP_LEDGER_LEAF } from "./domainTags.js";
import { EconomyCodecError, fromHex, toHex } from "./encoding.js";
import { sha256Tagged, type Hash32 } from "./hash.js";

// ---------- типы JSON-контракта ----------

/** Экономические параметры (FEP.md, Приложение A). В JSON журнала — snake_case. */
export type EconomyParametersJson = {
  demurrage_ppm_per_period: number;
  demurrage_period_ms: number;
  demurrage_exempt_threshold: number;
  ubi_per_epoch: number;
  ubi_epoch_ms: number;
  ubi_max_backfill_epochs: number;
  trustline_max_limit: number;
  credit_path_max_hops: number;
};

/** AccountId в JSON журнала — массив из 16 байт (сырые байты UUID). */
export type AccountIdJson = number[];

/** Тело записи журнала — все экономические события FEP v1 (`kind`-тег, camelCase). */
export type LedgerEntryBodyJson =
  | { kind: "genesis"; protocolVersion: number; params: EconomyParametersJson }
  | { kind: "parametersUpdated"; params: EconomyParametersJson; policyRef: string }
  | { kind: "accountOpened"; account: AccountIdJson; ownerKey: string }
  | {
      kind: "ubiIssued";
      account: AccountIdJson;
      fromEpoch: number;
      toEpoch: number;
      amount: number;
    }
  | { kind: "demurrageCharged"; account: AccountIdJson; periods: number; amount: number }
  | {
      kind: "transfer";
      from: AccountIdJson;
      to: AccountIdJson;
      amount: number;
      nonce: string;
      signature: string;
    }
  | {
      kind: "trustlineSet";
      lo: AccountIdJson;
      hi: AccountIdJson;
      limitLoToHi: number;
      limitHiToLo: number;
      signatureLo: string;
      signatureHi: string;
    }
  | {
      kind: "creditTransfer";
      path: AccountIdJson[];
      amount: number;
      nonce: string;
      signature: string;
    }
  | { kind: "commonsSpend"; to: AccountIdJson; amount: number; policyRef: string };

/** Запись журнала: порядковый номер, время, хеш-ссылка на предыдущую, тело. */
export type LedgerEntryJson = {
  seq: number;
  at: number;
  prevHash: string;
  body: LedgerEntryBodyJson;
};

/** Head журнала (Signed Tree Head) — то, что подписывают витнессы. */
export type LedgerHeadJson = {
  size: number;
  lastEntryHash: string;
  merkleRoot: string;
  at: number;
};

// ---------- аккаунты ----------

/** JSON-массив байт → 16-байтовый AccountId. */
export function accountBytesFromJson(value: AccountIdJson): Uint8Array {
  if (value.length !== 16) {
    throw new EconomyCodecError(`AccountId обязан быть 16 байт, получено ${value.length}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    const byte = value[i];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new EconomyCodecError(`AccountId: байт ${i} вне диапазона`);
    }
    out[i] = byte;
  }
  return out;
}

/** 16 байт → JSON-представление AccountId (массив чисел). */
export function accountJsonFromBytes(bytes: Uint8Array): AccountIdJson {
  if (bytes.length !== 16) {
    throw new EconomyCodecError(`AccountId обязан быть 16 байт, получено ${bytes.length}`);
  }
  return Array.from(bytes);
}

/** UUID (с дефисами или 32 hex-символа) → 16 байт AccountId. Аккаунт = UUID пользователя. */
export function accountBytesFromUuid(uuid: string): Uint8Array {
  const compact = uuid.replaceAll("-", "").toLowerCase();
  if (compact.length !== 32) {
    throw new EconomyCodecError(`некорректный UUID аккаунта: ${uuid}`);
  }
  return fromHex(compact, 16);
}

/** 16 байт AccountId → канонический UUID lowercase с дефисами. */
export function uuidFromAccountBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new EconomyCodecError(`AccountId обязан быть 16 байт, получено ${bytes.length}`);
  }
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------- канонические байты ----------

function writeParams(w: CanonicalWriter, p: EconomyParametersJson): void {
  w.u32(p.demurrage_ppm_per_period)
    .i64(p.demurrage_period_ms)
    .grains(BigInt(p.demurrage_exempt_threshold))
    .grains(BigInt(p.ubi_per_epoch))
    .i64(p.ubi_epoch_ms)
    .u64(p.ubi_max_backfill_epochs)
    .grains(BigInt(p.trustline_max_limit))
    .u8(p.credit_path_max_hops);
}

/** Канонические байты тела записи (consensus-путь: вход хеша записи). */
export function entryBodyCanonicalBytes(body: LedgerEntryBodyJson): Uint8Array {
  const w = new CanonicalWriter();
  switch (body.kind) {
    case "genesis": {
      w.u8(0).u16(body.protocolVersion);
      writeParams(w, body.params);
      break;
    }
    case "parametersUpdated": {
      w.u8(1);
      writeParams(w, body.params);
      w.str(body.policyRef);
      break;
    }
    case "accountOpened": {
      w.u8(2).account(accountBytesFromJson(body.account)).bytes(fromHex(body.ownerKey, 32));
      break;
    }
    case "ubiIssued": {
      w.u8(3)
        .account(accountBytesFromJson(body.account))
        .u64(body.fromEpoch)
        .u64(body.toEpoch)
        .grains(BigInt(body.amount));
      break;
    }
    case "demurrageCharged": {
      w.u8(4)
        .account(accountBytesFromJson(body.account))
        .u64(body.periods)
        .grains(BigInt(body.amount));
      break;
    }
    case "transfer": {
      w.u8(5)
        .account(accountBytesFromJson(body.from))
        .account(accountBytesFromJson(body.to))
        .grains(BigInt(body.amount))
        .bytes(fromHex(body.nonce, 16))
        .bytes(fromHex(body.signature, 64));
      break;
    }
    case "trustlineSet": {
      w.u8(6)
        .account(accountBytesFromJson(body.lo))
        .account(accountBytesFromJson(body.hi))
        .grains(BigInt(body.limitLoToHi))
        .grains(BigInt(body.limitHiToLo))
        .bytes(fromHex(body.signatureLo, 64))
        .bytes(fromHex(body.signatureHi, 64));
      break;
    }
    case "creditTransfer": {
      w.u8(7)
        .accountList(body.path.map(accountBytesFromJson))
        .grains(BigInt(body.amount))
        .bytes(fromHex(body.nonce, 16))
        .bytes(fromHex(body.signature, 64));
      break;
    }
    case "commonsSpend": {
      w.u8(8)
        .account(accountBytesFromJson(body.to))
        .grains(BigInt(body.amount))
        .str(body.policyRef);
      break;
    }
    default: {
      // Правило совместимости LIV.md §7: неизвестный вид записи — жёсткий отказ,
      // «мягкое непонимание» запрещено.
      const unknown: never = body;
      throw new EconomyCodecError(`неизвестный вид записи журнала: ${JSON.stringify(unknown)}`);
    }
  }
  return w.finish();
}

/** Хеш записи: `SHA-256(leaf-label ‖ seq ‖ at ‖ prev_hash ‖ body_bytes)`. */
export function entryHash(entry: LedgerEntryJson): Hash32 {
  const w = new CanonicalWriter();
  w.u64(entry.seq)
    .timestamp(entry.at)
    .hash32(fromHex(entry.prevHash, 32))
    .bytes(entryBodyCanonicalBytes(entry.body));
  return sha256Tagged(FEP_LEDGER_LEAF, w.finish());
}

/** Канонические байты head — вход подписи витнесса (`FEP_LEDGER_STH`). */
export function headCanonicalBytes(head: LedgerHeadJson): Uint8Array {
  const w = new CanonicalWriter();
  w.u64(head.size)
    .hash32(fromHex(head.lastEntryHash, 32))
    .hash32(fromHex(head.merkleRoot, 32))
    .timestamp(head.at);
  return w.finish();
}

// ---------- подписываемые байты транзакций (то, что подписывает кошелёк) ----------

/** Канонические байты авторизации перевода (подписывает отправитель). */
export function transferSigningBytes(
  from: Uint8Array,
  to: Uint8Array,
  amountGrains: bigint,
  nonce: Uint8Array,
): Uint8Array {
  if (nonce.length !== 16) {
    throw new EconomyCodecError(`nonce обязан быть 16 байт, получено ${nonce.length}`);
  }
  const w = new CanonicalWriter();
  w.account(from).account(to).grains(amountGrains).bytes(nonce);
  return w.finish();
}

/** Канонические байты авторизации линии доверия (подписывают обе стороны). */
export function trustlineSigningBytes(
  lo: Uint8Array,
  hi: Uint8Array,
  limitLoToHi: bigint,
  limitHiToLo: bigint,
): Uint8Array {
  const w = new CanonicalWriter();
  w.account(lo).account(hi).grains(limitLoToHi).grains(limitHiToLo);
  return w.finish();
}

/** Канонические байты авторизации платежа по цепочке доверия (подписывает плательщик). */
export function creditTransferSigningBytes(
  path: readonly Uint8Array[],
  amountGrains: bigint,
  nonce: Uint8Array,
): Uint8Array {
  if (nonce.length !== 16) {
    throw new EconomyCodecError(`nonce обязан быть 16 байт, получено ${nonce.length}`);
  }
  const w = new CanonicalWriter();
  w.accountList(path).grains(amountGrains).bytes(nonce);
  return w.finish();
}

// ---------- разбор JSON с границы системы ----------

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

function readHex(o: Record<string, unknown>, key: string, bytes: number, what: string): string {
  const v = readStr(o, key, what);
  fromHex(v, bytes); // валидация формы; значение остаётся hex-строкой
  return v;
}

function readAccount(o: Record<string, unknown>, key: string, what: string): AccountIdJson {
  const v = o[key];
  if (!Array.isArray(v)) {
    throw new EconomyCodecError(`${what}.${key}: ожидался массив из 16 байт`);
  }
  const json = v as AccountIdJson;
  accountBytesFromJson(json); // валидация
  return json;
}

function parseParams(value: unknown, what: string): EconomyParametersJson {
  const o = asRecord(value, what);
  return {
    demurrage_ppm_per_period: readSafeInt(o, "demurrage_ppm_per_period", what),
    demurrage_period_ms: readSafeInt(o, "demurrage_period_ms", what),
    demurrage_exempt_threshold: readSafeInt(o, "demurrage_exempt_threshold", what),
    ubi_per_epoch: readSafeInt(o, "ubi_per_epoch", what),
    ubi_epoch_ms: readSafeInt(o, "ubi_epoch_ms", what),
    ubi_max_backfill_epochs: readSafeInt(o, "ubi_max_backfill_epochs", what),
    trustline_max_limit: readSafeInt(o, "trustline_max_limit", what),
    credit_path_max_hops: readSafeInt(o, "credit_path_max_hops", what),
  };
}

/** Строгий разбор head из JSON (граница системы: HTTP-ответ сервера). */
export function parseLedgerHead(value: unknown): LedgerHeadJson {
  const o = asRecord(value, "LedgerHead");
  return {
    size: readSafeInt(o, "size", "LedgerHead"),
    lastEntryHash: readHex(o, "lastEntryHash", 32, "LedgerHead"),
    merkleRoot: readHex(o, "merkleRoot", 32, "LedgerHead"),
    at: readSafeInt(o, "at", "LedgerHead"),
  };
}

function parseBody(value: unknown): LedgerEntryBodyJson {
  const o = asRecord(value, "EntryBody");
  const kind = readStr(o, "kind", "EntryBody");
  switch (kind) {
    case "genesis":
      return {
        kind,
        protocolVersion: readSafeInt(o, "protocolVersion", kind),
        params: parseParams(o.params, `${kind}.params`),
      };
    case "parametersUpdated":
      return {
        kind,
        params: parseParams(o.params, `${kind}.params`),
        policyRef: readStr(o, "policyRef", kind),
      };
    case "accountOpened":
      return {
        kind,
        account: readAccount(o, "account", kind),
        ownerKey: readHex(o, "ownerKey", 32, kind),
      };
    case "ubiIssued":
      return {
        kind,
        account: readAccount(o, "account", kind),
        fromEpoch: readSafeInt(o, "fromEpoch", kind),
        toEpoch: readSafeInt(o, "toEpoch", kind),
        amount: readSafeInt(o, "amount", kind),
      };
    case "demurrageCharged":
      return {
        kind,
        account: readAccount(o, "account", kind),
        periods: readSafeInt(o, "periods", kind),
        amount: readSafeInt(o, "amount", kind),
      };
    case "transfer":
      return {
        kind,
        from: readAccount(o, "from", kind),
        to: readAccount(o, "to", kind),
        amount: readSafeInt(o, "amount", kind),
        nonce: readHex(o, "nonce", 16, kind),
        signature: readHex(o, "signature", 64, kind),
      };
    case "trustlineSet":
      return {
        kind,
        lo: readAccount(o, "lo", kind),
        hi: readAccount(o, "hi", kind),
        limitLoToHi: readSafeInt(o, "limitLoToHi", kind),
        limitHiToLo: readSafeInt(o, "limitHiToLo", kind),
        signatureLo: readHex(o, "signatureLo", 64, kind),
        signatureHi: readHex(o, "signatureHi", 64, kind),
      };
    case "creditTransfer": {
      const pathRaw = o.path;
      if (!Array.isArray(pathRaw)) {
        throw new EconomyCodecError("creditTransfer.path: ожидался массив аккаунтов");
      }
      const path = pathRaw.map((item, i) => {
        if (!Array.isArray(item)) {
          throw new EconomyCodecError(`creditTransfer.path[${i}]: ожидался массив байт`);
        }
        accountBytesFromJson(item as AccountIdJson);
        return item as AccountIdJson;
      });
      return {
        kind,
        path,
        amount: readSafeInt(o, "amount", kind),
        nonce: readHex(o, "nonce", 16, kind),
        signature: readHex(o, "signature", 64, kind),
      };
    }
    case "commonsSpend":
      return {
        kind,
        to: readAccount(o, "to", kind),
        amount: readSafeInt(o, "amount", kind),
        policyRef: readStr(o, "policyRef", kind),
      };
    default:
      // Неизвестный вид записи — отказ целиком (LIV.md §7).
      throw new EconomyCodecError(`неизвестный вид записи журнала: ${kind}`);
  }
}

/** Строгий разбор записи журнала из JSON (граница системы). */
export function parseLedgerEntry(value: unknown): LedgerEntryJson {
  const o = asRecord(value, "LedgerEntry");
  return {
    seq: readSafeInt(o, "seq", "LedgerEntry"),
    at: readSafeInt(o, "at", "LedgerEntry"),
    prevHash: readHex(o, "prevHash", 32, "LedgerEntry"),
    body: parseBody(o.body),
  };
}
