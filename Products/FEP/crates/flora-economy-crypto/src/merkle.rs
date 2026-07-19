//! Merkle-дерево журнала, совместимое по конструкции с RFC 6962 (Certificate Transparency),
//! FGP-CRYPTO §8. Даёт корень (для витнесс-косайнинга и внешнего якорения) и два вида
//! доказательств: **inclusion** (лист входит в дерево размера n) и **consistency** (дерево
//! размера m — префикс дерева размера n; журнал только дописывается, ничего не переписано).
//!
//! Доменные метки листа/узла ([`crate::domain`]) отделяют леденцы от узлов (защита от
//! second-preimage RFC 6962).

use crate::domain::{MERKLE_LEAF, MERKLE_NODE};
use crate::hash::{Hash32, tagged_parts};

/// Хеш листа: `H(leaf-label ‖ data)`.
pub fn hash_leaf(data: &[u8]) -> Hash32 {
    tagged_parts(MERKLE_LEAF, &[data])
}

/// Хеш внутреннего узла: `H(node-label ‖ left ‖ right)`.
pub fn hash_node(left: &Hash32, right: &Hash32) -> Hash32 {
    tagged_parts(MERKLE_NODE, &[left, right])
}

/// Корень Merkle Tree Hash (MTH) над списком **уже посчитанных хешей листьев**.
/// Пустое дерево — `H(leaf-label ‖ "")` не используется; для FEP пустого журнала не бывает
/// (первый лист — genesis), поэтому пустой вход даёт нулевой хеш-заглушку.
pub fn merkle_root(leaves: &[Hash32]) -> Hash32 {
    match leaves.len() {
        0 => [0u8; 32],
        1 => leaves[0],
        n => {
            let k = largest_power_of_two_below(n);
            let left = merkle_root(&leaves[..k]);
            let right = merkle_root(&leaves[k..]);
            hash_node(&left, &right)
        }
    }
}

/// Наибольшая степень двойки, строго меньшая `n` (RFC 6962 split point), `n >= 2`.
fn largest_power_of_two_below(n: usize) -> usize {
    debug_assert!(n >= 2);
    let mut k = 1;
    while k << 1 < n {
        k <<= 1;
    }
    k
}

/// Аудиторский путь (inclusion proof) для листа `index` в дереве из `leaves`.
pub fn inclusion_proof(leaves: &[Hash32], index: usize) -> Option<Vec<Hash32>> {
    if index >= leaves.len() {
        return None;
    }
    let mut proof = Vec::new();
    build_inclusion(leaves, index, &mut proof);
    Some(proof)
}

fn build_inclusion(leaves: &[Hash32], index: usize, proof: &mut Vec<Hash32>) {
    let n = leaves.len();
    if n <= 1 {
        return;
    }
    let k = largest_power_of_two_below(n);
    if index < k {
        // Лист в левом поддереве; в путь идёт корень правого.
        build_inclusion(&leaves[..k], index, proof);
        proof.push(merkle_root(&leaves[k..]));
    } else {
        build_inclusion(&leaves[k..], index - k, proof);
        proof.push(merkle_root(&leaves[..k]));
    }
}

/// Проверка inclusion-доказательства: восстанавливает корень из листа, индекса и пути.
///
/// Путь построен рекурсией сверху вниз с добавлением сиблинга **после** спуска, поэтому
/// последний элемент пути — сиблинг верхнего уровня; восстановление зеркалит построение,
/// потребляя путь с конца.
pub fn verify_inclusion(
    leaf: &Hash32,
    index: usize,
    tree_size: usize,
    proof: &[Hash32],
    expected_root: &Hash32,
) -> bool {
    match root_from_proof(leaf, index, tree_size, proof) {
        Some(root) => &root == expected_root,
        None => false,
    }
}

/// Consistency-доказательство (RFC 6962 §2.1.2): дерево размера `old_size` — префикс дерева
/// над `leaves`. Это криптографическое свидетельство append-only: старый head не переписан,
/// журнал только дорос. `None` при `old_size == 0` или `old_size > leaves.len()`.
///
/// Для `old_size == leaves.len()` доказательство пусто (равенство корней проверяется напрямую).
pub fn consistency_proof(leaves: &[Hash32], old_size: usize) -> Option<Vec<Hash32>> {
    if old_size == 0 || old_size > leaves.len() {
        return None;
    }
    let mut proof = Vec::new();
    if old_size < leaves.len() {
        build_consistency(leaves, old_size, true, &mut proof);
    }
    Some(proof)
}

/// Рекурсия SUBPROOF из RFC 6962: `old_is_subtree` — «старое дерево целиком совпадает
/// с текущим поддеревом» (тогда его корень известен проверяющему и в путь не входит).
fn build_consistency(
    leaves: &[Hash32],
    old_size: usize,
    old_is_subtree: bool,
    proof: &mut Vec<Hash32>,
) {
    let n = leaves.len();
    if old_size == n {
        if !old_is_subtree {
            proof.push(merkle_root(leaves));
        }
        return;
    }
    let k = largest_power_of_two_below(n);
    if old_size <= k {
        build_consistency(&leaves[..k], old_size, old_is_subtree, proof);
        proof.push(merkle_root(&leaves[k..]));
    } else {
        build_consistency(&leaves[k..], old_size - k, false, proof);
        proof.push(merkle_root(&leaves[..k]));
    }
}

/// Проверка consistency-доказательства (алгоритм RFC 9162 §2.1.4.2).
///
/// Возвращает `true`, только если `old_root` (дерево `old_size`) действительно является
/// префиксом `new_root` (дерево `new_size`) согласно `proof`.
pub fn verify_consistency(
    old_size: u64,
    new_size: u64,
    old_root: &Hash32,
    new_root: &Hash32,
    proof: &[Hash32],
) -> bool {
    if old_size == 0 || old_size > new_size {
        return false;
    }
    if old_size == new_size {
        return proof.is_empty() && old_root == new_root;
    }
    let mut path = proof.iter();
    // Если старое дерево — полное поддерево (размер 2^k), его корень известен проверяющему
    // и в путь не включается (RFC 9162: prepend first_hash).
    let first = if old_size.is_power_of_two() {
        *old_root
    } else {
        match path.next() {
            Some(h) => *h,
            None => return false,
        }
    };
    let mut fnode = old_size - 1;
    let mut snode = new_size - 1;
    while fnode & 1 == 1 {
        fnode >>= 1;
        snode >>= 1;
    }
    let mut fr = first;
    let mut sr = first;
    for c in path {
        if snode == 0 {
            return false;
        }
        if fnode & 1 == 1 || fnode == snode {
            fr = hash_node(c, &fr);
            sr = hash_node(c, &sr);
            if fnode & 1 == 0 {
                while fnode != 0 && fnode & 1 == 0 {
                    fnode >>= 1;
                    snode >>= 1;
                }
            }
        } else {
            sr = hash_node(&sr, c);
        }
        fnode >>= 1;
        snode >>= 1;
    }
    &fr == old_root && &sr == new_root && snode == 0
}

fn root_from_proof(leaf: &Hash32, index: usize, size: usize, proof: &[Hash32]) -> Option<Hash32> {
    if index >= size {
        return None;
    }
    if size == 1 {
        return proof.is_empty().then_some(*leaf);
    }
    let (top_sibling, rest) = proof.split_last()?;
    let k = largest_power_of_two_below(size);
    if index < k {
        let left = root_from_proof(leaf, index, k, rest)?;
        Some(hash_node(&left, top_sibling))
    } else {
        let right = root_from_proof(leaf, index - k, size - k, rest)?;
        Some(hash_node(top_sibling, &right))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::tagged;

    fn leaf(i: u8) -> Hash32 {
        hash_leaf(&tagged("flora/economy/v1/test", &[i]))
    }

    #[test]
    fn single_leaf_root_is_the_leaf() {
        let l = leaf(0);
        assert_eq!(merkle_root(&[l]), l);
    }

    #[test]
    fn inclusion_verifies_for_every_index() {
        for n in 1..=33usize {
            let leaves: Vec<Hash32> = (0..n).map(|i| leaf(i as u8)).collect();
            let root = merkle_root(&leaves);
            for i in 0..n {
                let proof = inclusion_proof(&leaves, i).expect("proof");
                assert!(
                    verify_inclusion(&leaves[i], i, n, &proof, &root),
                    "inclusion failed n={n} i={i}"
                );
            }
        }
    }

    #[test]
    fn tampered_leaf_fails_verification() {
        let leaves: Vec<Hash32> = (0..8).map(|i| leaf(i as u8)).collect();
        let root = merkle_root(&leaves);
        let proof = inclusion_proof(&leaves, 3).unwrap();
        let wrong = leaf(99);
        assert!(!verify_inclusion(&wrong, 3, 8, &proof, &root));
    }

    #[test]
    fn wrong_index_fails() {
        let leaves: Vec<Hash32> = (0..8).map(|i| leaf(i as u8)).collect();
        let root = merkle_root(&leaves);
        let proof = inclusion_proof(&leaves, 3).unwrap();
        assert!(!verify_inclusion(&leaves[3], 4, 8, &proof, &root));
    }

    #[test]
    fn appended_tree_changes_root() {
        let small: Vec<Hash32> = (0..4).map(|i| leaf(i as u8)).collect();
        let mut big = small.clone();
        big.push(leaf(4));
        assert_ne!(merkle_root(&small), merkle_root(&big));
    }

    #[test]
    fn consistency_verifies_for_all_prefixes() {
        for n in 1..=33usize {
            let leaves: Vec<Hash32> = (0..n).map(|i| leaf(i as u8)).collect();
            let new_root = merkle_root(&leaves);
            for m in 1..=n {
                let old_root = merkle_root(&leaves[..m]);
                let proof = consistency_proof(&leaves, m).expect("proof");
                assert!(
                    verify_consistency(m as u64, n as u64, &old_root, &new_root, &proof),
                    "consistency failed m={m} n={n}"
                );
            }
        }
    }

    #[test]
    fn consistency_rejects_forked_history() {
        let n = 13usize;
        let leaves: Vec<Hash32> = (0..n).map(|i| leaf(i as u8)).collect();
        let new_root = merkle_root(&leaves);
        // «Форк»: другая история тех же размеров.
        let mut forked = leaves.clone();
        forked[2] = leaf(99);
        let forked_old = merkle_root(&forked[..6]);
        let proof = consistency_proof(&leaves, 6).unwrap();
        assert!(!verify_consistency(
            6,
            n as u64,
            &forked_old,
            &new_root,
            &proof
        ));
        // Испорченный элемент пути.
        let mut tampered = proof.clone();
        tampered[0] = leaf(77);
        let old_root = merkle_root(&leaves[..6]);
        assert!(!verify_consistency(
            6, n as u64, &old_root, &new_root, &tampered
        ));
        // Усечённый путь.
        let truncated = &proof[..proof.len() - 1];
        assert!(!verify_consistency(
            6, n as u64, &old_root, &new_root, truncated
        ));
    }

    #[test]
    fn consistency_proof_bounds() {
        let leaves: Vec<Hash32> = (0..5).map(|i| leaf(i as u8)).collect();
        assert!(consistency_proof(&leaves, 0).is_none(), "old_size=0");
        assert!(consistency_proof(&leaves, 6).is_none(), "old_size > n");
        let same = consistency_proof(&leaves, 5).unwrap();
        assert!(same.is_empty(), "равные размеры — пустой путь");
        let root = merkle_root(&leaves);
        assert!(verify_consistency(5, 5, &root, &root, &[]));
        assert!(!verify_consistency(0, 5, &root, &root, &[]));
        assert!(!verify_consistency(6, 5, &root, &root, &[]));
    }
}
