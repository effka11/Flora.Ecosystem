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
}
