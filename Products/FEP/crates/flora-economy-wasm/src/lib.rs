//! C-ABI wasm32-поверхность детерминированного ядра FEP — уровень L2 клиентской
//! верификации LIV (LIV.md §5): «не верь серверу, проверь сам».
//!
//! Архитектура — паттерн FRC (`frc-i-wasm`): без wasm-bindgen, ручной минимальный FFI.
//! Вся консенсусная логика остаётся в `flora-economy-crypto`; шим только переносит
//! байты через границу. Структурированные данные — JSON-байты (тот же контракт, что
//! JSONL-журнал и HTTP API): serde парсит суммы с полной точностью i64, а агрегаты
//! в вердикте отдаются **строками** — JS-число теряет целые выше 2^53.
//!
//! ## ABI (стабильный, версия — [`fep_abi_version`])
//!
//! - память: `fep_alloc(len) -> ptr` / `fep_free(ptr, len)`; вход копирует вызывающий;
//! - `fep_replay(entries, len, out, cap) -> n` — JSON-массив записей → JSON-вердикт;
//!   `n > 0` — байт записано; `-1` — некорректный вход; `-2` — буфер мал (повторить
//!   с большим `cap`);
//! - `fep_entry_hash(entry, len, out32) -> 0 | -1`;
//! - `fep_verify_inclusion(...) / fep_verify_consistency(...) / fep_verify_cosign(...)`
//!   → `1` — доказано, `0` — нет, `-1` — некорректный вход.
//!
//! Потребитель — `@flora/client-core/economy` (`FepWasmVerifier`); паритет ABI
//! зафиксирован native-тестами этого crate и интеграционным тестом TS-обвязки.

use flora_economy_crypto::FEP_PROTOCOL_VERSION;
use flora_economy_crypto::engine::LedgerState;
use flora_economy_crypto::hash::Hash32;
use flora_economy_crypto::ledger::LedgerEntry;
use flora_economy_crypto::merkle;
use flora_economy_crypto::witness::{HeadCosign, verify_head_cosign};

/// Версия шима; полный идентификатор ABI — `(протокол << 8) | шим`.
const WASM_SHIM_VERSION: u32 = 1;

/// Версия ABI: старшие биты — версия протокола FEP, младший байт — версия шима.
#[unsafe(no_mangle)]
pub extern "C" fn fep_abi_version() -> u32 {
    (u32::from(FEP_PROTOCOL_VERSION) << 8) | WASM_SHIM_VERSION
}

/// Выделить буфер в линейной памяти модуля (владение — у вызывающего до `fep_free`).
#[unsafe(no_mangle)]
pub extern "C" fn fep_alloc(length: usize) -> *mut u8 {
    if length == 0 {
        return core::ptr::null_mut();
    }
    let mut buffer = Vec::<u8>::with_capacity(length);
    let pointer = buffer.as_mut_ptr();
    core::mem::forget(buffer);
    pointer
}

/// Освободить буфер, выделенный `fep_alloc` (та же длина обязательна).
///
/// # Safety
/// `pointer`/`length` обязаны соответствовать одному прежнему вызову `fep_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fep_free(pointer: *mut u8, length: usize) {
    if pointer.is_null() || length == 0 {
        return;
    }
    drop(unsafe { Vec::from_raw_parts(pointer, 0, length) });
}

/// Срез входных байт; `None` — некорректные аргументы.
///
/// # Safety
/// `pointer` обязан указывать на `length` доступных байт (буфер `fep_alloc`).
unsafe fn input_slice<'a>(pointer: *const u8, length: usize) -> Option<&'a [u8]> {
    if length == 0 {
        return Some(&[]);
    }
    if pointer.is_null() {
        return None;
    }
    Some(unsafe { core::slice::from_raw_parts(pointer, length) })
}

/// Прочитать 32-байтовый хеш.
///
/// # Safety
/// `pointer` обязан указывать на 32 доступных байта.
unsafe fn read_hash(pointer: *const u8) -> Option<Hash32> {
    if pointer.is_null() {
        return None;
    }
    let mut hash = [0u8; 32];
    unsafe { core::ptr::copy_nonoverlapping(pointer, hash.as_mut_ptr(), 32) };
    Some(hash)
}

/// Прочитать доказательство: `count` подряд лежащих 32-байтовых хешей.
///
/// # Safety
/// `pointer` обязан указывать на `count * 32` доступных байт (при `count > 0`).
unsafe fn read_proof(pointer: *const u8, count: u32) -> Option<Vec<Hash32>> {
    let count = count as usize;
    if count == 0 {
        return Some(Vec::new());
    }
    if pointer.is_null() {
        return None;
    }
    let bytes = unsafe { core::slice::from_raw_parts(pointer, count * 32) };
    Some(
        bytes
            .chunks_exact(32)
            .map(|chunk| {
                let mut hash = [0u8; 32];
                hash.copy_from_slice(chunk);
                hash
            })
            .collect(),
    )
}

/// Реплей журнала с точкой отказа: позиция записи в массиве, а не заявленный `seq`
/// (сам `seq` может быть частью подделки).
fn replay_verdict(entries: &[LedgerEntry]) -> serde_json::Value {
    let Some((genesis, rest)) = entries.split_first() else {
        return serde_json::json!({
            "ok": false,
            "seq": 0,
            "error": "пустой журнал: нет genesis-записи",
        });
    };
    let mut state = match LedgerState::from_genesis(genesis) {
        Ok(state) => state,
        Err(error) => {
            return serde_json::json!({ "ok": false, "seq": 0, "error": error.to_string() });
        }
    };
    for (position, entry) in rest.iter().enumerate() {
        if let Err(error) = state.apply(entry) {
            return serde_json::json!({
                "ok": false,
                "seq": position + 1,
                "error": error.to_string(),
            });
        }
    }
    serde_json::json!({
        "ok": true,
        "head": state.head,
        "summary": {
            "entries": state.head.size,
            "accounts": state.accounts.len() as u64,
            "trustlines": state.trustlines.len() as u64,
            // Строки: суммы-агрегаты могут превышать безопасный диапазон JS-числа.
            "commonsBalanceGrains": state.commons_balance.0.to_string(),
            "totalIssuedGrains": state.total_issued.0.to_string(),
        },
    })
}

/// Полный L2-реплей: JSON-массив записей журнала → JSON-вердикт.
///
/// Возврат: `n > 0` — байт вердикта записано в `out`; `-1` — некорректный вход
/// (null/не UTF-8/не JSON-массив записей); `-2` — `out_cap` мал, повторить с большим.
///
/// # Safety
/// `entries_ptr`/`entries_len` — валидный вход; `out_ptr` — буфер на `out_cap` байт.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fep_replay(
    entries_ptr: *const u8,
    entries_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    let Some(input) = (unsafe { input_slice(entries_ptr, entries_len) }) else {
        return -1;
    };
    if out_ptr.is_null() {
        return -1;
    }
    let Ok(entries) = serde_json::from_slice::<Vec<LedgerEntry>>(input) else {
        return -1;
    };
    let verdict = replay_verdict(&entries);
    let json = serde_json::to_vec(&verdict).expect("вердикт всегда сериализуем");
    if json.len() > out_cap || json.len() > i32::MAX as usize {
        return -2;
    }
    unsafe { core::ptr::copy_nonoverlapping(json.as_ptr(), out_ptr, json.len()) };
    json.len() as i32
}

/// Хеш записи журнала, посчитанный ядром: JSON записи → 32 байта в `out32`.
///
/// # Safety
/// `entry_ptr`/`entry_len` — валидный вход; `out32_ptr` — буфер на 32 байта.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fep_entry_hash(
    entry_ptr: *const u8,
    entry_len: usize,
    out32_ptr: *mut u8,
) -> i32 {
    let Some(input) = (unsafe { input_slice(entry_ptr, entry_len) }) else {
        return -1;
    };
    if out32_ptr.is_null() {
        return -1;
    }
    let Ok(entry) = serde_json::from_slice::<LedgerEntry>(input) else {
        return -1;
    };
    let hash = entry.entry_hash();
    unsafe { core::ptr::copy_nonoverlapping(hash.as_ptr(), out32_ptr, 32) };
    0
}

/// Inclusion-доказательство (L0): лист `index` входит в дерево размера `tree_size`.
///
/// # Safety
/// `leaf32_ptr`/`root32_ptr` — 32 байта; `proof_ptr` — `proof_count * 32` байт.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fep_verify_inclusion(
    leaf32_ptr: *const u8,
    index: u64,
    tree_size: u64,
    proof_ptr: *const u8,
    proof_count: u32,
    root32_ptr: *const u8,
) -> i32 {
    let (Some(leaf), Some(root), Some(proof)) = (
        unsafe { read_hash(leaf32_ptr) },
        unsafe { read_hash(root32_ptr) },
        unsafe { read_proof(proof_ptr, proof_count) },
    ) else {
        return -1;
    };
    let (Ok(index), Ok(tree_size)) = (usize::try_from(index), usize::try_from(tree_size)) else {
        return 0;
    };
    i32::from(merkle::verify_inclusion(
        &leaf, index, tree_size, &proof, &root,
    ))
}

/// Consistency-доказательство (L1): дерево `old_size/old_root` — префикс `new_size/new_root`.
///
/// # Safety
/// `old_root32_ptr`/`new_root32_ptr` — 32 байта; `proof_ptr` — `proof_count * 32` байт.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fep_verify_consistency(
    old_size: u64,
    new_size: u64,
    old_root32_ptr: *const u8,
    new_root32_ptr: *const u8,
    proof_ptr: *const u8,
    proof_count: u32,
) -> i32 {
    let (Some(old_root), Some(new_root), Some(proof)) = (
        unsafe { read_hash(old_root32_ptr) },
        unsafe { read_hash(new_root32_ptr) },
        unsafe { read_proof(proof_ptr, proof_count) },
    ) else {
        return -1;
    };
    i32::from(merkle::verify_consistency(
        old_size, new_size, &old_root, &new_root, &proof,
    ))
}

/// Косайн витнесса: JSON `HeadCosign` → `1` подпись валидна / `0` нет / `-1` не JSON.
///
/// # Safety
/// `cosign_ptr`/`cosign_len` — валидный вход.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fep_verify_cosign(cosign_ptr: *const u8, cosign_len: usize) -> i32 {
    let Some(input) = (unsafe { input_slice(cosign_ptr, cosign_len) }) else {
        return -1;
    };
    let Ok(cosign) = serde_json::from_slice::<HeadCosign>(input) else {
        return -1;
    };
    i32::from(verify_head_cosign(&cosign).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flora_economy_crypto::amount::{AccountId, Grains, Timestamp};
    use flora_economy_crypto::hash::ZERO_HASH;
    use flora_economy_crypto::ledger::{EntryBody, trustline_signing_bytes};
    use flora_economy_crypto::params::Parameters;
    use flora_economy_crypto::sig::{public_key, sign};
    use flora_economy_crypto::{domain, witness};

    const ALICE_SEED: [u8; 32] = [0x11; 32];
    const BOB_SEED: [u8; 32] = [0x22; 32];
    const WITNESS_SEED: [u8; 32] = [0x77; 32];
    const ALICE: AccountId = AccountId([0xAA; 16]);
    const BOB: AccountId = AccountId([0xBB; 16]);
    const T0: i64 = 1_700_000_000_000;

    /// Журнал: genesis → два аккаунта → линия доверия (подписи обеих сторон).
    fn sample_journal() -> Vec<LedgerEntry> {
        let mut entries = Vec::new();
        let mut prev = ZERO_HASH;
        let mut push = |entries: &mut Vec<LedgerEntry>, at: i64, body: EntryBody| {
            let entry = LedgerEntry {
                seq: entries.len() as u64,
                at: Timestamp(at),
                prev_hash: prev,
                body,
            };
            prev = entry.entry_hash();
            entries.push(entry);
        };
        push(
            &mut entries,
            T0,
            EntryBody::Genesis {
                protocol_version: FEP_PROTOCOL_VERSION,
                params: Parameters::genesis(),
            },
        );
        push(
            &mut entries,
            T0 + 1_000,
            EntryBody::AccountOpened {
                account: ALICE,
                owner_key: public_key(&ALICE_SEED),
            },
        );
        push(
            &mut entries,
            T0 + 2_000,
            EntryBody::AccountOpened {
                account: BOB,
                owner_key: public_key(&BOB_SEED),
            },
        );
        let limit_ab = Grains(100_000);
        let limit_ba = Grains(50_000);
        let payload = trustline_signing_bytes(&ALICE, &BOB, limit_ab, limit_ba);
        push(
            &mut entries,
            T0 + 3_000,
            EntryBody::TrustlineSet {
                lo: ALICE,
                hi: BOB,
                limit_lo_to_hi: limit_ab,
                limit_hi_to_lo: limit_ba,
                signature_lo: sign(domain::TRUSTLINE_AUTH, &payload, &ALICE_SEED),
                signature_hi: sign(domain::TRUSTLINE_AUTH, &payload, &BOB_SEED),
            },
        );
        entries
    }

    fn replay_json(entries_json: &[u8], out_cap: usize) -> (i32, Vec<u8>) {
        let mut out = vec![0u8; out_cap];
        let code = unsafe {
            fep_replay(
                entries_json.as_ptr(),
                entries_json.len(),
                out.as_mut_ptr(),
                out.len(),
            )
        };
        (code, out)
    }

    #[test]
    fn abi_version_encodes_protocol_and_shim() {
        assert_eq!(fep_abi_version(), (1 << 8) | 1);
    }

    #[test]
    fn alloc_free_roundtrip() {
        let pointer = fep_alloc(64);
        assert!(!pointer.is_null());
        unsafe { fep_free(pointer, 64) };
        assert!(fep_alloc(0).is_null());
    }

    #[test]
    fn replay_valid_journal_reports_head_and_summary() {
        let entries = sample_journal();
        let expected = LedgerState::replay(&entries).expect("журнал валиден");
        let json = serde_json::to_vec(&entries).unwrap();
        let (code, out) = replay_json(&json, 64 * 1024);
        assert!(code > 0, "код {code}");
        let verdict: serde_json::Value = serde_json::from_slice(&out[..code as usize]).unwrap();
        assert_eq!(verdict["ok"], serde_json::json!(true));
        assert_eq!(
            verdict["head"],
            serde_json::to_value(&expected.head).unwrap()
        );
        assert_eq!(verdict["summary"]["entries"], serde_json::json!(4));
        assert_eq!(verdict["summary"]["accounts"], serde_json::json!(2));
        assert_eq!(verdict["summary"]["trustlines"], serde_json::json!(1));
        assert_eq!(
            verdict["summary"]["totalIssuedGrains"],
            serde_json::json!("0")
        );
    }

    #[test]
    fn replay_reports_capacity_shortage() {
        let json = serde_json::to_vec(&sample_journal()).unwrap();
        let (code, _) = replay_json(&json, 8);
        assert_eq!(code, -2);
    }

    #[test]
    fn replay_rejects_tampered_signature() {
        let mut entries = sample_journal();
        if let EntryBody::TrustlineSet { signature_lo, .. } = &mut entries[3].body {
            signature_lo[0] ^= 0x01;
        } else {
            panic!("ожидалась запись TrustlineSet");
        }
        // Хеш-цепочку чиним, чтобы отказ был именно криптографическим (подпись).
        let mut prev = entries[0].entry_hash();
        for entry in entries.iter_mut().skip(1) {
            entry.prev_hash = prev;
            prev = entry.entry_hash();
        }
        let json = serde_json::to_vec(&entries).unwrap();
        let (code, out) = replay_json(&json, 64 * 1024);
        assert!(code > 0, "код {code}");
        let verdict: serde_json::Value = serde_json::from_slice(&out[..code as usize]).unwrap();
        assert_eq!(verdict["ok"], serde_json::json!(false));
        assert_eq!(verdict["seq"], serde_json::json!(3));
    }

    #[test]
    fn replay_rejects_broken_chain_and_garbage() {
        let mut entries = sample_journal();
        entries[2].prev_hash = [0xFF; 32];
        let json = serde_json::to_vec(&entries).unwrap();
        let (code, out) = replay_json(&json, 64 * 1024);
        assert!(code > 0);
        let verdict: serde_json::Value = serde_json::from_slice(&out[..code as usize]).unwrap();
        assert_eq!(verdict["ok"], serde_json::json!(false));
        assert_eq!(verdict["seq"], serde_json::json!(2));

        let (code, _) = replay_json(b"not json", 1024);
        assert_eq!(code, -1);
    }

    #[test]
    fn entry_hash_matches_core() {
        let entries = sample_journal();
        let json = serde_json::to_vec(&entries[1]).unwrap();
        let mut out = [0u8; 32];
        let code = unsafe { fep_entry_hash(json.as_ptr(), json.len(), out.as_mut_ptr()) };
        assert_eq!(code, 0);
        assert_eq!(out, entries[1].entry_hash());
    }

    #[test]
    fn inclusion_and_consistency_via_abi() {
        let entries = sample_journal();
        let leaves: Vec<Hash32> = entries
            .iter()
            .map(|e| merkle::hash_leaf(&e.entry_hash()))
            .collect();
        let root = merkle::merkle_root(&leaves);
        let proof = merkle::inclusion_proof(&leaves, 1).unwrap();
        let proof_bytes: Vec<u8> = proof.iter().flatten().copied().collect();
        let ok = unsafe {
            fep_verify_inclusion(
                leaves[1].as_ptr(),
                1,
                leaves.len() as u64,
                proof_bytes.as_ptr(),
                proof.len() as u32,
                root.as_ptr(),
            )
        };
        assert_eq!(ok, 1);
        let bad = unsafe {
            fep_verify_inclusion(
                leaves[0].as_ptr(),
                1,
                leaves.len() as u64,
                proof_bytes.as_ptr(),
                proof.len() as u32,
                root.as_ptr(),
            )
        };
        assert_eq!(bad, 0);

        let old_root = merkle::merkle_root(&leaves[..2]);
        let cons = merkle::consistency_proof(&leaves, 2).unwrap();
        let cons_bytes: Vec<u8> = cons.iter().flatten().copied().collect();
        let ok = unsafe {
            fep_verify_consistency(
                2,
                leaves.len() as u64,
                old_root.as_ptr(),
                root.as_ptr(),
                cons_bytes.as_ptr(),
                cons.len() as u32,
            )
        };
        assert_eq!(ok, 1);
        let fork = unsafe {
            fep_verify_consistency(
                2,
                leaves.len() as u64,
                root.as_ptr(),
                root.as_ptr(),
                cons_bytes.as_ptr(),
                cons.len() as u32,
            )
        };
        assert_eq!(fork, 0);
    }

    #[test]
    fn cosign_verification_via_abi() {
        let entries = sample_journal();
        let state = LedgerState::replay(&entries).unwrap();
        let cosign = witness::cosign_head(&state.head, &WITNESS_SEED);
        let json = serde_json::to_vec(&cosign).unwrap();
        assert_eq!(unsafe { fep_verify_cosign(json.as_ptr(), json.len()) }, 1);

        let mut tampered = cosign.clone();
        tampered.head.size += 1;
        let json = serde_json::to_vec(&tampered).unwrap();
        assert_eq!(unsafe { fep_verify_cosign(json.as_ptr(), json.len()) }, 0);

        assert_eq!(unsafe { fep_verify_cosign(json.as_ptr(), 3) }, -1);
    }
}
