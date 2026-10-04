/**
 * L2-верификация LIV в браузере: типизированная обвязка wasm-поверхности ядра
 * (`flora-economy-wasm`, C-ABI без wasm-bindgen — паттерн FRC).
 *
 * Полный реплей журнала с экономическими инвариантами выполняет **то же самое**
 * детерминированное ядро, что и сервер, скомпилированное в wasm32 — «не верь серверу,
 * проверь сам» без дублирования движка в TS (LIV.md §5, L2).
 *
 * Сборка артефакта:
 * `cargo build -p flora-economy-wasm --target wasm32-unknown-unknown --release`
 * → `target/wasm32-unknown-unknown/release/flora_economy_wasm.wasm`.
 *
 * Данные через границу — JSON-байты: суммы парсит serde (полный i64), агрегаты
 * в вердикте — строками (JS-число теряет точность выше 2^53).
 */

import type { LedgerEntryJson, LedgerHeadJson } from "./ledger.js";
import { parseLedgerHead } from "./ledger.js";
import { EconomyCodecError } from "./encoding.js";

/** Версия ABI wasm-поверхности: `(протокол FEP << 8) | версия шима`. */
export const FEP_WASM_ABI_VERSION = (1 << 8) | 1;

/** Экспорты wasm-модуля `flora-economy-wasm` (C-ABI). */
export type FepWasmExports = {
  memory: WebAssembly.Memory;
  fep_abi_version(): number;
  fep_alloc(length: number): number;
  fep_free(pointer: number, length: number): void;
  /** JSON-массив записей → JSON-вердикт; `n>0` — байт записано, `-1` — вход, `-2` — буфер мал. */
  fep_replay(entriesPtr: number, entriesLen: number, outPtr: number, outCap: number): number;
  /** JSON записи → 32 байта хеша; `0` — ок, `-1` — некорректный вход. */
  fep_entry_hash(entryPtr: number, entryLen: number, out32Ptr: number): number;
  /** `1` — включена, `0` — нет, `-1` — некорректный вход. */
  fep_verify_inclusion(
    leaf32Ptr: number,
    index: bigint,
    treeSize: bigint,
    proofPtr: number,
    proofCount: number,
    root32Ptr: number,
  ): number;
  /** `1` — согласован, `0` — нет, `-1` — некорректный вход. */
  fep_verify_consistency(
    oldSize: bigint,
    newSize: bigint,
    oldRoot32Ptr: number,
    newRoot32Ptr: number,
    proofPtr: number,
    proofCount: number,
  ): number;
  /** JSON косайна → `1` валиден / `0` нет / `-1` некорректный вход. */
  fep_verify_cosign(cosignPtr: number, cosignLen: number): number;
};

/** Ошибка обвязки wasm-поверхности (несовместимый ABI, некорректные аргументы). */
export class FepWasmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FepWasmError";
  }
}

/** Вердикт полного L2-реплея журнала детерминированным ядром. */
export type FepReplayVerdict =
  | {
      ok: true;
      head: LedgerHeadJson;
      summary: {
        entries: number;
        accounts: number;
        trustlines: number;
        commonsBalanceGrains: bigint;
        totalIssuedGrains: bigint;
      };
    }
  | { ok: false; seq: number; error: string };

const INITIAL_REPLAY_CAPACITY = 64 * 1024;

/** Верификатор L2 поверх экземпляра wasm-модуля ядра. */
export class FepWasmVerifier {
  private readonly exports: FepWasmExports;

  private constructor(exports: FepWasmExports) {
    const abi = exports.fep_abi_version();
    if (abi !== FEP_WASM_ABI_VERSION) {
      throw new FepWasmError(
        `несовместимый ABI flora-economy-wasm: ожидался ${FEP_WASM_ABI_VERSION}, получен ${abi}`,
      );
    }
    this.exports = exports;
  }

  /** Обернуть уже инстанцированные экспорты (модуль без import-секции). */
  static fromExports(exports: FepWasmExports): FepWasmVerifier {
    return new FepWasmVerifier(exports);
  }

  /** Инстанцировать из байтов `.wasm` или скомпилированного модуля. */
  static async instantiate(source: BufferSource | WebAssembly.Module): Promise<FepWasmVerifier> {
    const instance =
      source instanceof WebAssembly.Module
        ? await WebAssembly.instantiate(source, {})
        : (await WebAssembly.instantiate(source, {})).instance;
    return new FepWasmVerifier(instance.exports as unknown as FepWasmExports);
  }

  private memory(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer);
  }

  private writeBytes(bytes: Uint8Array): { ptr: number; len: number } {
    if (bytes.length === 0) {
      return { ptr: 0, len: 0 };
    }
    const ptr = this.exports.fep_alloc(bytes.length);
    if (ptr === 0) throw new FepWasmError("fep_alloc вернул нулевой указатель");
    // Вид на память берём после alloc: рост памяти отсоединяет прежний ArrayBuffer.
    this.memory().set(bytes, ptr);
    return { ptr, len: bytes.length };
  }

  private free(ptr: number, len: number): void {
    if (ptr !== 0 && len > 0) this.exports.fep_free(ptr, len);
  }

  /** Полный L2-реплей: журнал целиком → head + сводка состояния либо точка отказа. */
  replay(entries: readonly LedgerEntryJson[]): FepReplayVerdict {
    const input = new TextEncoder().encode(JSON.stringify(entries));
    const { ptr, len } = this.writeBytes(input);
    try {
      let capacity = INITIAL_REPLAY_CAPACITY;
      for (;;) {
        const outPtr = this.exports.fep_alloc(capacity);
        if (outPtr === 0) throw new FepWasmError("fep_alloc вернул нулевой указатель");
        try {
          const n = this.exports.fep_replay(ptr, len, outPtr, capacity);
          if (n === -2) {
            capacity *= 4;
            continue;
          }
          if (n < 0) {
            throw new FepWasmError(`fep_replay отверг вход (код ${n})`);
          }
          const json = new TextDecoder().decode(this.memory().subarray(outPtr, outPtr + n));
          return parseReplayVerdict(JSON.parse(json));
        } finally {
          this.exports.fep_free(outPtr, capacity);
        }
      }
    } finally {
      this.free(ptr, len);
    }
  }

  /** Хеш записи, посчитанный ядром (кросс-проверка TS-реализации). */
  entryHash(entry: LedgerEntryJson): Uint8Array {
    const input = new TextEncoder().encode(JSON.stringify(entry));
    const { ptr, len } = this.writeBytes(input);
    const outPtr = this.exports.fep_alloc(32);
    try {
      const code = this.exports.fep_entry_hash(ptr, len, outPtr);
      if (code !== 0) throw new FepWasmError(`fep_entry_hash отверг вход (код ${code})`);
      return this.memory().slice(outPtr, outPtr + 32);
    } finally {
      this.exports.fep_free(outPtr, 32);
      this.free(ptr, len);
    }
  }

  /** Inclusion-доказательство, проверенное ядром. */
  verifyInclusion(input: {
    leaf: Uint8Array;
    index: number;
    treeSize: number;
    proof: readonly Uint8Array[];
    root: Uint8Array;
  }): boolean {
    if (input.leaf.length !== 32 || input.root.length !== 32) return false;
    const proofBytes = concatHashes(input.proof);
    if (proofBytes === null) return false;
    const leaf = this.writeBytes(input.leaf);
    const root = this.writeBytes(input.root);
    const proof = this.writeBytes(proofBytes);
    try {
      const code = this.exports.fep_verify_inclusion(
        leaf.ptr,
        BigInt(input.index),
        BigInt(input.treeSize),
        proof.ptr,
        input.proof.length,
        root.ptr,
      );
      return code === 1;
    } finally {
      this.free(proof.ptr, proof.len);
      this.free(root.ptr, root.len);
      this.free(leaf.ptr, leaf.len);
    }
  }

  /** Consistency-доказательство, проверенное ядром. */
  verifyConsistency(input: {
    oldSize: number;
    newSize: number;
    oldRoot: Uint8Array;
    newRoot: Uint8Array;
    proof: readonly Uint8Array[];
  }): boolean {
    if (input.oldRoot.length !== 32 || input.newRoot.length !== 32) return false;
    const proofBytes = concatHashes(input.proof);
    if (proofBytes === null) return false;
    const oldRoot = this.writeBytes(input.oldRoot);
    const newRoot = this.writeBytes(input.newRoot);
    const proof = this.writeBytes(proofBytes);
    try {
      const code = this.exports.fep_verify_consistency(
        BigInt(input.oldSize),
        BigInt(input.newSize),
        oldRoot.ptr,
        newRoot.ptr,
        proof.ptr,
        input.proof.length,
      );
      return code === 1;
    } finally {
      this.free(proof.ptr, proof.len);
      this.free(newRoot.ptr, newRoot.len);
      this.free(oldRoot.ptr, oldRoot.len);
    }
  }

  /** Косайн витнесса, проверенный ядром. */
  verifyCosign(cosignJson: unknown): boolean {
    const input = new TextEncoder().encode(JSON.stringify(cosignJson));
    const { ptr, len } = this.writeBytes(input);
    try {
      return this.exports.fep_verify_cosign(ptr, len) === 1;
    } finally {
      this.free(ptr, len);
    }
  }
}

function concatHashes(hashes: readonly Uint8Array[]): Uint8Array | null {
  const out = new Uint8Array(hashes.length * 32);
  for (let i = 0; i < hashes.length; i += 1) {
    const h = hashes[i]!;
    if (h.length !== 32) return null;
    out.set(h, i * 32);
  }
  return out;
}

function parseReplayVerdict(value: unknown): FepReplayVerdict {
  if (typeof value !== "object" || value === null) {
    throw new EconomyCodecError("вердикт реплея: ожидался JSON-объект");
  }
  const o = value as Record<string, unknown>;
  if (o.ok === true) {
    const s = o.summary as Record<string, unknown> | undefined;
    if (!s || typeof s !== "object") {
      throw new EconomyCodecError("вердикт реплея: отсутствует summary");
    }
    const readCount = (key: string): number => {
      const v = s[key];
      if (typeof v !== "number" || !Number.isSafeInteger(v)) {
        throw new EconomyCodecError(`вердикт реплея: summary.${key} не целое`);
      }
      return v;
    };
    const readGrainsString = (key: string): bigint => {
      const v = s[key];
      if (typeof v !== "string") {
        throw new EconomyCodecError(`вердикт реплея: summary.${key} обязан быть строкой grain`);
      }
      return BigInt(v);
    };
    return {
      ok: true,
      head: parseLedgerHead(o.head),
      summary: {
        entries: readCount("entries"),
        accounts: readCount("accounts"),
        trustlines: readCount("trustlines"),
        commonsBalanceGrains: readGrainsString("commonsBalanceGrains"),
        totalIssuedGrains: readGrainsString("totalIssuedGrains"),
      },
    };
  }
  if (o.ok === false) {
    const seq = o.seq;
    const error = o.error;
    if (typeof seq !== "number" || typeof error !== "string") {
      throw new EconomyCodecError("вердикт реплея: некорректная форма ошибки");
    }
    return { ok: false, seq, error };
  }
  throw new EconomyCodecError("вердикт реплея: отсутствует поле ok");
}
