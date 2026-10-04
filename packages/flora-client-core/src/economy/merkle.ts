/**
 * Merkle-верификация журнала FEP — зеркало `flora-economy-crypto::merkle`
 * (RFC 6962/9162, Certificate Transparency).
 *
 * Клиенту нужны: корень (для сверки head при реплее хеш-цепочки), проверка
 * **inclusion** («моя запись в журнале», L0) и проверка **consistency**
 * («журнал только дописывается», L1). Построение доказательств — задача сервера.
 * Доменные метки листа/узла защищают от second-preimage (RFC 6962 §2.1).
 */

import { FEP_MERKLE_LEAF, FEP_MERKLE_NODE } from "./domainTags.js";
import { bytesEqual } from "./encoding.js";
import { sha256Tagged, type Hash32 } from "./hash.js";

/** Хеш листа: `SHA-256(leaf-label ‖ data)`. */
export function merkleLeafHash(data: Uint8Array): Hash32 {
  return sha256Tagged(FEP_MERKLE_LEAF, data);
}

/** Хеш внутреннего узла: `SHA-256(node-label ‖ left ‖ right)`. */
export function merkleNodeHash(left: Hash32, right: Hash32): Hash32 {
  return sha256Tagged(FEP_MERKLE_NODE, left, right);
}

/** Наибольшая степень двойки, строго меньшая `n` (RFC 6962 split point), `n >= 2`. */
function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k << 1 < n) {
    k <<= 1;
  }
  return k;
}

/**
 * Корень Merkle Tree Hash над **уже посчитанными хешами листьев**.
 * Пустой вход — нулевой хеш-заглушка (журнала без genesis не бывает).
 */
export function merkleRoot(leaves: readonly Hash32[]): Hash32 {
  if (leaves.length === 0) return new Uint8Array(32);
  if (leaves.length === 1) return leaves[0]!;
  const k = largestPowerOfTwoBelow(leaves.length);
  return merkleNodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

function rootFromInclusionProof(
  leaf: Hash32,
  index: number,
  size: number,
  proof: readonly Hash32[],
): Hash32 | null {
  if (index >= size) return null;
  if (size === 1) {
    return proof.length === 0 ? leaf : null;
  }
  if (proof.length === 0) return null;
  const topSibling = proof[proof.length - 1]!;
  const rest = proof.slice(0, -1);
  const k = largestPowerOfTwoBelow(size);
  if (index < k) {
    const left = rootFromInclusionProof(leaf, index, k, rest);
    return left === null ? null : merkleNodeHash(left, topSibling);
  }
  const right = rootFromInclusionProof(leaf, index - k, size - k, rest);
  return right === null ? null : merkleNodeHash(topSibling, right);
}

/** Проверка inclusion-доказательства: лист `index` входит в дерево размера `treeSize`. */
export function verifyInclusion(
  leaf: Hash32,
  index: number,
  treeSize: number,
  proof: readonly Hash32[],
  expectedRoot: Hash32,
): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(treeSize) || index < 0) {
    return false;
  }
  const root = rootFromInclusionProof(leaf, index, treeSize, proof);
  return root !== null && bytesEqual(root, expectedRoot);
}

/**
 * Проверка consistency-доказательства (RFC 9162 §2.1.4.2): дерево `oldSize` с корнем
 * `oldRoot` — префикс дерева `newSize` с корнем `newRoot`. `true` только при
 * криптографически подтверждённом «журнал только дорос».
 */
export function verifyConsistency(
  oldSize: number,
  newSize: number,
  oldRoot: Hash32,
  newRoot: Hash32,
  proof: readonly Hash32[],
): boolean {
  if (
    !Number.isSafeInteger(oldSize) ||
    !Number.isSafeInteger(newSize) ||
    oldSize <= 0 ||
    oldSize > newSize
  ) {
    return false;
  }
  if (oldSize === newSize) {
    return proof.length === 0 && bytesEqual(oldRoot, newRoot);
  }

  let cursor = 0;
  // Полное поддерево (2^k): его корень известен проверяющему и в путь не входит.
  const oldIsPowerOfTwo = (oldSize & (oldSize - 1)) === 0;
  let first: Hash32;
  if (oldIsPowerOfTwo) {
    first = oldRoot;
  } else {
    if (proof.length === 0) return false;
    first = proof[0]!;
    cursor = 1;
  }

  let fnode = oldSize - 1;
  let snode = newSize - 1;
  while ((fnode & 1) === 1) {
    fnode = Math.floor(fnode / 2);
    snode = Math.floor(snode / 2);
  }
  let fr = first;
  let sr = first;
  for (; cursor < proof.length; cursor += 1) {
    const c = proof[cursor]!;
    if (snode === 0) return false;
    if ((fnode & 1) === 1 || fnode === snode) {
      fr = merkleNodeHash(c, fr);
      sr = merkleNodeHash(c, sr);
      if ((fnode & 1) === 0) {
        while (fnode !== 0 && (fnode & 1) === 0) {
          fnode = Math.floor(fnode / 2);
          snode = Math.floor(snode / 2);
        }
      }
    } else {
      sr = merkleNodeHash(sr, c);
    }
    fnode = Math.floor(fnode / 2);
    snode = Math.floor(snode / 2);
  }
  return bytesEqual(fr, oldRoot) && bytesEqual(sr, newRoot) && snode === 0;
}
