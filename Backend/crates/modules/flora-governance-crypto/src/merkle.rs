//! Merkle-журнал прозрачности CT-класса (FGP-CRYPTO §8).
//!
//! Алгоритмы дерева, inclusion- и consistency-пруфов — RFC 6962/9162 с одной заменой:
//! вместо байтовых префиксов `0x00`/`0x01` типы узлов разделяются доменными метками
//! BLAKE3 (`flora/log/v1/leaf` и `flora/log/v1/node`) — та же цель (second-preimage
//! resistance между листом и узлом), более сильное средство.
//!
//! Модуль — чистые функции над срезами хешей листьев: персистентность, батчинг и
//! витнесс-протокол — забота инфраструктурного слоя `flora-governance` (FGP §8.1).
//! Пруфы бит-в-бит зафиксированы вектором `governance-log-merkle-v1.json`
//! (+ негативы отдельным файлом).

use crate::ds;

/// Хеш (32 байта BLAKE3).
pub type Hash = [u8; 32];

/// Корень пустого журнала (`derive("flora/log/v1/node", "")` — как в CT: хеш пустой строки).
pub fn empty_root() -> Hash {
    ds::derive(ds::LOG_NODE, b"")
}

/// Хеш листа журнала из его байтового содержимого.
pub fn leaf_hash(leaf: &[u8]) -> Hash {
    ds::derive(ds::LOG_LEAF, leaf)
}

fn node_hash(left: &Hash, right: &Hash) -> Hash {
    let mut material = [0u8; 64];
    material[..32].copy_from_slice(left);
    material[32..].copy_from_slice(right);
    ds::derive(ds::LOG_NODE, &material)
}

/// Наибольшая степень двойки, строго меньшая `n` (RFC 6962: split-point).
fn split_point(n: usize) -> usize {
    debug_assert!(n > 1);
    let k = usize::BITS - (n - 1).leading_zeros() - 1;
    1 << k
}

/// Merkle tree head над хешами листьев (RFC 6962 §2.1, MTH).
pub fn root(leaf_hashes: &[Hash]) -> Hash {
    match leaf_hashes {
        [] => empty_root(),
        [single] => *single,
        _ => {
            let k = split_point(leaf_hashes.len());
            node_hash(&root(&leaf_hashes[..k]), &root(&leaf_hashes[k..]))
        }
    }
}

/// Inclusion-пруф листа `index` (RFC 6962 §2.1.1, PATH). `None`, если индекс вне дерева.
pub fn inclusion_proof(leaf_hashes: &[Hash], index: usize) -> Option<Vec<Hash>> {
    if index >= leaf_hashes.len() {
        return None;
    }
    let mut path = Vec::new();
    collect_inclusion(leaf_hashes, index, &mut path);
    Some(path)
}

fn collect_inclusion(leaves: &[Hash], m: usize, out: &mut Vec<Hash>) {
    if leaves.len() <= 1 {
        return;
    }
    let k = split_point(leaves.len());
    if m < k {
        collect_inclusion(&leaves[..k], m, out);
        out.push(root(&leaves[k..]));
    } else {
        collect_inclusion(&leaves[k..], m - k, out);
        out.push(root(&leaves[..k]));
    }
}

/// Проверка inclusion-пруфа (RFC 9162 §2.1.3.2).
pub fn verify_inclusion(
    expected_root: &Hash,
    tree_size: u64,
    leaf_index: u64,
    leaf_hash: &Hash,
    proof: &[Hash],
) -> bool {
    if leaf_index >= tree_size {
        return false;
    }
    let mut fnode = leaf_index;
    let mut snode = tree_size - 1;
    let mut r = *leaf_hash;
    for p in proof {
        if snode == 0 {
            return false;
        }
        if fnode & 1 == 1 || fnode == snode {
            r = node_hash(p, &r);
            if fnode & 1 == 0 {
                // Правый край: поднимаемся, пока не станем левым потомком.
                while fnode & 1 == 0 && fnode != 0 {
                    fnode >>= 1;
                    snode >>= 1;
                }
            }
        } else {
            r = node_hash(&r, p);
        }
        fnode >>= 1;
        snode >>= 1;
    }
    snode == 0 && r == *expected_root
}

/// Consistency-пруф между префиксом размера `old_size` и всем деревом
/// (RFC 6962 §2.1.2, PROOF). `None` при `old_size == 0` или `old_size > n`.
pub fn consistency_proof(leaf_hashes: &[Hash], old_size: usize) -> Option<Vec<Hash>> {
    if old_size == 0 || old_size > leaf_hashes.len() {
        return None;
    }
    if old_size == leaf_hashes.len() {
        return Some(Vec::new());
    }
    let mut path = Vec::new();
    collect_consistency(leaf_hashes, old_size, true, &mut path);
    Some(path)
}

fn collect_consistency(leaves: &[Hash], m: usize, complete: bool, out: &mut Vec<Hash>) {
    if m == leaves.len() {
        if !complete {
            out.push(root(leaves));
        }
        return;
    }
    let k = split_point(leaves.len());
    if m <= k {
        collect_consistency(&leaves[..k], m, complete, out);
        out.push(root(&leaves[k..]));
    } else {
        collect_consistency(&leaves[k..], m - k, false, out);
        out.push(root(&leaves[..k]));
    }
}

/// Проверка consistency-пруфа (RFC 9162 §2.1.4.2).
pub fn verify_consistency(
    old_size: u64,
    new_size: u64,
    old_root: &Hash,
    new_root: &Hash,
    proof: &[Hash],
) -> bool {
    if old_size == 0 || old_size > new_size {
        return false;
    }
    if old_size == new_size {
        return proof.is_empty() && old_root == new_root;
    }
    // Если old_size — степень двойки, old_root префикса является узлом нового
    // дерева и в пруф не входит: подставляем его первым элементом сами.
    let mut elements = proof.iter();
    let (mut fr, mut sr) = if old_size.is_power_of_two() {
        (*old_root, *old_root)
    } else {
        let Some(first) = elements.next() else {
            return false;
        };
        (*first, *first)
    };
    let mut fnode = old_size - 1;
    let mut snode = new_size - 1;
    while fnode & 1 == 1 {
        fnode >>= 1;
        snode >>= 1;
    }
    for c in elements.by_ref() {
        if snode == 0 {
            return false;
        }
        if fnode & 1 == 1 || fnode == snode {
            fr = node_hash(c, &fr);
            sr = node_hash(c, &sr);
            if fnode & 1 == 0 {
                while fnode & 1 == 0 && fnode != 0 {
                    fnode >>= 1;
                    snode >>= 1;
                }
            }
        } else {
            sr = node_hash(&sr, c);
        }
        fnode >>= 1;
        snode >>= 1;
    }
    snode == 0 && fr == *old_root && sr == *new_root
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Детерминированные синтетические листья.
    fn leaves(n: usize) -> Vec<Hash> {
        (0..n)
            .map(|i| leaf_hash(format!("test-leaf-{i}").as_bytes()))
            .collect()
    }

    #[test]
    fn empty_and_single() {
        assert_eq!(root(&[]), empty_root());
        let l = leaves(1);
        assert_eq!(root(&l), l[0]);
    }

    #[test]
    fn root_changes_with_any_leaf() {
        let base = leaves(8);
        let base_root = root(&base);
        for i in 0..8 {
            let mut tampered = base.clone();
            tampered[i] = leaf_hash(b"tampered");
            assert_ne!(root(&tampered), base_root, "лист {i}");
        }
    }

    #[test]
    fn inclusion_all_indices_up_to_65() {
        for n in 1..=65usize {
            let l = leaves(n);
            let r = root(&l);
            for i in 0..n {
                let proof = inclusion_proof(&l, i).unwrap();
                assert!(
                    verify_inclusion(&r, n as u64, i as u64, &l[i], &proof),
                    "n={n} i={i}"
                );
                // Чужой лист с этим пруфом не проходит.
                let wrong = leaf_hash(b"other");
                assert!(!verify_inclusion(&r, n as u64, i as u64, &wrong, &proof));
            }
        }
    }

    #[test]
    fn inclusion_rejects_tampered_proofs() {
        let l = leaves(13);
        let r = root(&l);
        let proof = inclusion_proof(&l, 5).unwrap();
        // Индекс не тот.
        assert!(!verify_inclusion(&r, 13, 6, &l[5], &proof));
        // Элемент пруфа подменён.
        let mut bad = proof.clone();
        bad[0] = leaf_hash(b"evil");
        assert!(!verify_inclusion(&r, 13, 5, &l[5], &bad));
        // Пруф укорочен / удлинён.
        assert!(!verify_inclusion(
            &r,
            13,
            5,
            &l[5],
            &proof[..proof.len() - 1]
        ));
        let mut long = proof.clone();
        long.push(leaf_hash(b"extra"));
        assert!(!verify_inclusion(&r, 13, 5, &l[5], &long));
        // Индекс за деревом.
        assert!(!verify_inclusion(&r, 13, 13, &l[5], &proof));
    }

    #[test]
    fn consistency_all_pairs_up_to_65() {
        let full = leaves(65);
        for n in 1..=65usize {
            let new_root = root(&full[..n]);
            for m in 1..=n {
                let old_root = root(&full[..m]);
                let proof = consistency_proof(&full[..n], m).unwrap();
                assert!(
                    verify_consistency(m as u64, n as u64, &old_root, &new_root, &proof),
                    "m={m} n={n}"
                );
            }
        }
    }

    #[test]
    fn consistency_rejects_forks() {
        let honest = leaves(11);
        let old_root = root(&honest[..6]);
        let new_root = root(&honest);
        let proof = consistency_proof(&honest, 6).unwrap();

        // Форк: другой префикс истории с тем же размером.
        let mut forked = honest.clone();
        forked[2] = leaf_hash(b"rewritten history");
        let forked_old = root(&forked[..6]);
        assert!(!verify_consistency(6, 11, &forked_old, &new_root, &proof));

        // Подмена элемента пруфа.
        let mut bad = proof.clone();
        bad[0] = leaf_hash(b"evil");
        assert!(!verify_consistency(6, 11, &old_root, &new_root, &bad));

        // Неверные размеры.
        assert!(!verify_consistency(0, 11, &old_root, &new_root, &proof));
        assert!(!verify_consistency(12, 11, &old_root, &new_root, &proof));
        assert!(!verify_consistency(6, 6, &old_root, &new_root, &proof));

        // old == new: пруф обязан быть пустым, корни — совпадать.
        assert!(verify_consistency(11, 11, &new_root, &new_root, &[]));
        assert!(!verify_consistency(11, 11, &old_root, &new_root, &[]));
    }

    #[test]
    fn proof_generation_bounds() {
        let l = leaves(5);
        assert!(inclusion_proof(&l, 5).is_none());
        assert!(consistency_proof(&l, 0).is_none());
        assert!(consistency_proof(&l, 6).is_none());
        assert_eq!(consistency_proof(&l, 5).unwrap(), Vec::<Hash>::new());
    }
}
