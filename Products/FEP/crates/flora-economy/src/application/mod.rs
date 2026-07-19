//! Application-слой Economy: [`EconomyService`] — секвенсор журнала FEP.
//!
//! Единственный писатель: каждая операция строится как кандидат-запись, прогоняется через
//! движок ядра (все инварианты), при успехе — durable-append в хранилище и только затем
//! коммит состояния в памяти. Порядок «сначала диск, потом память» гарантирует, что память
//! никогда не впереди журнала (при сбое диска операция просто не произошла).
//!
//! Авторизация — криптографическая: переводы валидны подписью Ed25519 владельца, а не
//! HTTP-сессией. Сервис не доверяет вызывающему слою решать, «чей» это аккаунт.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use flora_economy_contracts::{
    CommonsSummaryDto, EconomyAccountProvisioner, EconomyAccountSummaryDto, EconomyPortError,
    EconomyReadPort, LedgerHeadDto,
};
use flora_economy_crypto::EconomyError;
use flora_economy_crypto::FEP_PROTOCOL_VERSION;
use flora_economy_crypto::amount::{AccountId, Grains, Timestamp};
use flora_economy_crypto::demurrage::{apply_demurrage, full_periods};
use flora_economy_crypto::engine::LedgerState;
use flora_economy_crypto::hash::{Hash32, to_hex};
use flora_economy_crypto::issuance::{claimable_epochs, epoch_index, ubi_amount};
use flora_economy_crypto::ledger::{EntryBody, LedgerEntry, LedgerHead};
use flora_economy_crypto::merkle;
use flora_economy_crypto::params::Parameters;
use flora_economy_crypto::sig::PublicKeyBytes;
use flora_economy_crypto::witness::{HeadCosign, verify_head_cosign};
use flora_verification_contracts::{PersonhoodAttestor, PersonhoodLevel};
use uuid::Uuid;

use crate::domain::{account_id_of, sequencer_time, wall_clock_now_ms};
use crate::infrastructure::{CosignStore, LedgerStore, StoreError};

/// Ошибки application-слоя: экономические (ядро), инфраструктурные (хранилище)
/// либо протокол витнессов.
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error(transparent)]
    Economy(#[from] EconomyError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("витнесс не входит в реестр")]
    UnknownWitness,
    #[error("косайн не соответствует журналу: {0}")]
    CosignMismatch(String),
}

/// Изменяемая часть сервиса под одним замком: состояние + индексы для витнесс-протокола.
/// Один Mutex вместо трёх — исключает взаимные блокировки и рассинхрон между полями.
struct Inner {
    state: LedgerState,
    /// Метки времени всех записей (индекс = seq): валидация `head.at` исторических косайнов.
    entry_ats: Vec<Timestamp>,
    /// Самый свежий валидный косайн каждого витнесса (BTreeMap — детерминированный порядок).
    cosigns: BTreeMap<PublicKeyBytes, HeadCosign>,
}

/// Секвенсор FEP. Держит реплеенное состояние в памяти; журнал — источник истины.
pub struct EconomyService {
    store: Arc<dyn LedgerStore>,
    cosign_store: Arc<dyn CosignStore>,
    /// Реестр витнессов (governance-параметр; для reference-развёртывания — из конфига).
    witnesses: Vec<PublicKeyBytes>,
    attestor: Arc<dyn PersonhoodAttestor>,
    inner: Mutex<Inner>,
}

/// Результат применённой операции — для HTTP-ответов.
#[derive(Debug, Clone)]
pub struct AppliedEntry {
    pub seq: u64,
    pub entry_hash: Hash32,
    pub at: Timestamp,
}

/// Consistency-доказательство между двумя размерами журнала (для HTTP-слоя).
#[derive(Debug, Clone)]
pub struct ConsistencySlice {
    pub old_size: u64,
    pub new_size: u64,
    pub old_root: Hash32,
    pub new_root: Hash32,
    pub proof: Vec<Hash32>,
    pub head: LedgerHead,
}

impl EconomyService {
    /// Открыть сервис: реплей журнала из хранилища; пустое хранилище — записать genesis.
    /// Персистентные косайны перепроверяются против восстановленной цепочки; невалидные
    /// (форк, неизвестный витнесс после смены реестра) молча отбрасываются.
    pub fn open(
        store: Arc<dyn LedgerStore>,
        cosign_store: Arc<dyn CosignStore>,
        witnesses: Vec<PublicKeyBytes>,
        attestor: Arc<dyn PersonhoodAttestor>,
    ) -> Result<EconomyService, EconomyError> {
        let entries = store.load_all().map_err(|e| EconomyError::ReplayDiverged {
            expected: "читаемый журнал".into(),
            actual: e.to_string(),
        })?;
        let (state, entry_ats) = if entries.is_empty() {
            let genesis = LedgerEntry {
                seq: 0,
                at: Timestamp(wall_clock_now_ms()),
                prev_hash: flora_economy_crypto::hash::ZERO_HASH,
                body: EntryBody::Genesis {
                    protocol_version: FEP_PROTOCOL_VERSION,
                    params: Parameters::genesis(),
                },
            };
            let state = LedgerState::from_genesis(&genesis)?;
            store
                .append(&genesis)
                .map_err(|e| EconomyError::ReplayDiverged {
                    expected: "записываемый журнал".into(),
                    actual: e.to_string(),
                })?;
            (state, vec![genesis.at])
        } else {
            let ats = entries.iter().map(|e| e.at).collect();
            (LedgerState::replay(&entries)?, ats)
        };

        let service = EconomyService {
            store,
            cosign_store,
            witnesses,
            attestor,
            inner: Mutex::new(Inner {
                state,
                entry_ats,
                cosigns: BTreeMap::new(),
            }),
        };

        // Реплей косайнов: помним только те, что валидны против текущей цепочки.
        let persisted =
            service
                .cosign_store
                .load_all()
                .map_err(|e| EconomyError::ReplayDiverged {
                    expected: "читаемый файл косайнов".into(),
                    actual: e.to_string(),
                })?;
        {
            let mut inner = service.inner.lock().expect("mutex не отравлен");
            for cosign in persisted {
                if validate_cosign(&inner, &service.witnesses, &cosign).is_ok() {
                    remember_cosign(&mut inner, cosign);
                }
            }
        }
        Ok(service)
    }

    /// Общий путь всех операций: собрать запись при текущем head, применить к копии
    /// состояния (все инварианты), durable-append, коммит в память.
    fn sequence(&self, body: EntryBody) -> Result<AppliedEntry, ServiceError> {
        let mut inner = self.inner.lock().expect("mutex не отравлен");
        let at = sequencer_time(wall_clock_now_ms(), inner.state.head.at);
        let entry = LedgerEntry {
            seq: inner.state.head.size,
            at,
            prev_hash: inner.state.head.last_entry_hash,
            body,
        };
        // Применяем к клону: при любой ошибке ни память, ни диск не меняются.
        let mut next = inner.state.clone();
        next.apply(&entry)?;
        self.store.append(&entry)?;
        inner.state = next;
        inner.entry_ats.push(at);
        Ok(AppliedEntry {
            seq: entry.seq,
            entry_hash: entry.entry_hash(),
            at,
        })
    }

    fn lock_inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().expect("mutex не отравлен")
    }

    // ---------- команды ----------

    /// Открыть аккаунт (идемпотентно: повторное открытие того же аккаунта — не ошибка).
    pub fn open_account(
        &self,
        account_uuid: Uuid,
        owner_key: [u8; 32],
    ) -> Result<EconomyAccountSummaryDto, ServiceError> {
        let id = account_id_of(account_uuid);
        {
            let inner = self.lock_inner();
            if inner.state.accounts.contains_key(&id) {
                return self
                    .account_summary_inner(&inner.state, account_uuid)
                    .map_err(ServiceError::Economy);
            }
        }
        self.sequence(EntryBody::AccountOpened {
            account: id,
            owner_key,
        })?;
        let inner = self.lock_inner();
        self.account_summary_inner(&inner.state, account_uuid)
            .map_err(ServiceError::Economy)
    }

    /// Начислить UBI. Требование — активная personhood-аттестация V1+ (FPP §2):
    /// эмиссия привязана к живым людям, не к записям в БД.
    pub fn claim_ubi(&self, account_uuid: Uuid) -> Result<AppliedEntry, ServiceError> {
        if self.attestor.active_level(account_uuid) < PersonhoodLevel::V1 {
            return Err(EconomyError::PersonhoodRequired.into());
        }
        let id = account_id_of(account_uuid);
        let (from, to, amount) = {
            let inner = self.lock_inner();
            let state = &inner.state;
            let account = state
                .accounts
                .get(&id)
                .ok_or(EconomyError::AccountNotFound(id))?;
            let now = sequencer_time(wall_clock_now_ms(), state.head.at);
            let epoch = epoch_index(state.genesis_at, now, state.params.ubi_epoch_ms);
            let (from, to) = claimable_epochs(
                account.last_ubi_epoch,
                epoch,
                state.params.ubi_max_backfill_epochs,
            )
            .ok_or(EconomyError::UbiAlreadyClaimed)?;
            (from, to, ubi_amount(from, to, &state.params))
        };
        self.sequence(EntryBody::UbiIssued {
            account: id,
            from_epoch: from,
            to_epoch: to,
            amount,
        })
    }

    /// Перевод LIV (подпись отправителя обязательна, проверяется ядром).
    pub fn transfer(
        &self,
        from: Uuid,
        to: Uuid,
        amount: Grains,
        nonce: [u8; 16],
        signature: [u8; 64],
    ) -> Result<AppliedEntry, ServiceError> {
        self.sequence(EntryBody::Transfer {
            from: account_id_of(from),
            to: account_id_of(to),
            amount,
            nonce,
            signature,
        })
    }

    /// Открыть/изменить линию доверия (две подписи, канонический порядок пары — ядро проверит).
    #[allow(clippy::too_many_arguments)]
    pub fn set_trustline(
        &self,
        lo: Uuid,
        hi: Uuid,
        limit_lo_to_hi: Grains,
        limit_hi_to_lo: Grains,
        signature_lo: [u8; 64],
        signature_hi: [u8; 64],
    ) -> Result<AppliedEntry, ServiceError> {
        self.sequence(EntryBody::TrustlineSet {
            lo: account_id_of(lo),
            hi: account_id_of(hi),
            limit_lo_to_hi,
            limit_hi_to_lo,
            signature_lo,
            signature_hi,
        })
    }

    /// Платёж по цепочке доверия.
    pub fn credit_transfer(
        &self,
        path: Vec<Uuid>,
        amount: Grains,
        nonce: [u8; 16],
        signature: [u8; 64],
    ) -> Result<AppliedEntry, ServiceError> {
        self.sequence(EntryBody::CreditTransfer {
            path: path.into_iter().map(account_id_of).collect(),
            amount,
            nonce,
            signature,
        })
    }

    /// Демерредж-обход: начислить всем аккаунтам с истёкшими периодами.
    /// Возвращает число записей. Вызывается фоновой задачей продукта (например, раз в час);
    /// идемпотентен — без истёкших периодов не пишет ничего.
    pub fn sweep_demurrage(&self) -> Result<usize, ServiceError> {
        let due: Vec<(AccountId, u64, Grains)> = {
            let inner = self.lock_inner();
            let state = &inner.state;
            let now = sequencer_time(wall_clock_now_ms(), state.head.at);
            state
                .accounts
                .iter()
                .filter_map(|(id, account)| {
                    let periods = full_periods(
                        account.demurrage_applied_at,
                        now,
                        state.params.demurrage_period_ms,
                    );
                    if periods == 0 {
                        return None;
                    }
                    let outcome = apply_demurrage(account.balance, periods, &state.params);
                    Some((*id, periods, outcome.to_commons))
                })
                .collect()
        };
        let mut written = 0usize;
        for (account, periods, amount) in due {
            // Между снапшотом и записью мог пройти перевод — ядро пересчитает и отклонит
            // разошедшиеся записи; такие аккаунты доберёт следующий sweep.
            match self.sequence(EntryBody::DemurrageCharged {
                account,
                periods,
                amount,
            }) {
                Ok(_) => written += 1,
                Err(ServiceError::Economy(
                    EconomyError::ReplayDiverged { .. } | EconomyError::DemurrageAlreadyApplied,
                )) => continue,
                Err(e) => return Err(e),
            }
        }
        Ok(written)
    }

    // ---------- витнесс-протокол ----------

    /// Принять косайн витнесса: криптографическая проверка + сверка head с историей
    /// журнала + принадлежность реестру. Валидный косайн durable-персистится и попадает
    /// в STH-ответ. Идемпотентно: повторный косайн того же head — не ошибка.
    pub fn submit_cosign(&self, cosign: HeadCosign) -> Result<(), ServiceError> {
        let mut inner = self.lock_inner();
        validate_cosign(&inner, &self.witnesses, &cosign)?;
        let already_known = inner
            .cosigns
            .get(&cosign.witness)
            .is_some_and(|known| known.head.size >= cosign.head.size);
        if !already_known {
            self.cosign_store.append(&cosign)?;
            remember_cosign(&mut inner, cosign);
        }
        Ok(())
    }

    /// Signed Tree Head: текущий head + свежайшие косайны + реестр витнессов.
    pub fn sth(&self) -> (LedgerHead, Vec<HeadCosign>, Vec<PublicKeyBytes>) {
        let inner = self.lock_inner();
        (
            inner.state.head.clone(),
            inner.cosigns.values().cloned().collect(),
            self.witnesses.clone(),
        )
    }

    /// Consistency-доказательство: журнал размера `old_size` — префикс размера `new_size`
    /// (по умолчанию — текущего). `None` при некорректном диапазоне.
    pub fn consistency(&self, old_size: u64, new_size: Option<u64>) -> Option<ConsistencySlice> {
        let inner = self.lock_inner();
        let current = inner.state.head.size;
        let new_size = new_size.unwrap_or(current);
        if old_size == 0 || old_size > new_size || new_size > current {
            return None;
        }
        let leaves: Vec<Hash32> = inner.state.entry_hashes[..new_size as usize]
            .iter()
            .map(|h| merkle::hash_leaf(h))
            .collect();
        let proof = merkle::consistency_proof(&leaves, old_size as usize)?;
        Some(ConsistencySlice {
            old_size,
            new_size,
            old_root: merkle::merkle_root(&leaves[..old_size as usize]),
            new_root: merkle::merkle_root(&leaves),
            proof,
            head: inner.state.head.clone(),
        })
    }

    // ---------- запросы ----------

    /// Текущий head журнала.
    pub fn head(&self) -> LedgerHead {
        self.lock_inner().state.head.clone()
    }

    /// Текущие параметры.
    pub fn parameters(&self) -> Parameters {
        self.lock_inner().state.params.clone()
    }

    /// Страница журнала (для клиентского реплея).
    pub fn entries(&self, from: u64, limit: usize) -> Result<Vec<LedgerEntry>, ServiceError> {
        let all = self.store.load_all()?;
        Ok(all
            .into_iter()
            .skip(from as usize)
            .take(limit.min(1000))
            .collect())
    }

    /// Merkle-inclusion-доказательство записи `seq` против текущего head.
    pub fn inclusion_proof(&self, seq: u64) -> Option<(Vec<Hash32>, LedgerHead)> {
        let inner = self.lock_inner();
        let leaves: Vec<Hash32> = inner
            .state
            .entry_hashes
            .iter()
            .map(|h| merkle::hash_leaf(h))
            .collect();
        let proof = merkle::inclusion_proof(&leaves, seq as usize)?;
        Some((proof, inner.state.head.clone()))
    }

    fn account_summary_inner(
        &self,
        state: &LedgerState,
        account_uuid: Uuid,
    ) -> Result<EconomyAccountSummaryDto, EconomyError> {
        let id = account_id_of(account_uuid);
        let account = state
            .accounts
            .get(&id)
            .ok_or(EconomyError::AccountNotFound(id))?;
        Ok(EconomyAccountSummaryDto {
            account_uuid,
            balance_grains: account.balance.0,
            last_ubi_epoch: account.last_ubi_epoch,
            demurrage_applied_at_ms: account.demurrage_applied_at.0,
        })
    }
}

/// Полная проверка косайна против внутреннего состояния:
/// 1) витнесс в реестре; 2) подпись валидна; 3) head существует в **нашей** истории
///    (размер, хеш последней записи, Merkle-корень префикса, метка времени).
///
/// Пункт 3 — ключевой: витнесс мог подписать head **чужого** (форкнутого) журнала,
/// и такой косайн обязан быть отвергнут, иначе STH-ответ станет свидетельством форка.
fn validate_cosign(
    inner: &Inner,
    witnesses: &[PublicKeyBytes],
    cosign: &HeadCosign,
) -> Result<(), ServiceError> {
    if !witnesses.contains(&cosign.witness) {
        return Err(ServiceError::UnknownWitness);
    }
    verify_head_cosign(cosign).map_err(ServiceError::Economy)?;

    let size = cosign.head.size;
    if size == 0 || size > inner.state.head.size {
        return Err(ServiceError::CosignMismatch(format!(
            "size {size} вне журнала (текущий {})",
            inner.state.head.size
        )));
    }
    let idx = (size - 1) as usize;
    if cosign.head.last_entry_hash != inner.state.entry_hashes[idx] {
        return Err(ServiceError::CosignMismatch(
            "lastEntryHash не совпадает с историей журнала".into(),
        ));
    }
    let leaves: Vec<Hash32> = inner.state.entry_hashes[..size as usize]
        .iter()
        .map(|h| merkle::hash_leaf(h))
        .collect();
    if cosign.head.merkle_root != merkle::merkle_root(&leaves) {
        return Err(ServiceError::CosignMismatch(
            "merkleRoot не совпадает с историей журнала".into(),
        ));
    }
    if cosign.head.at != inner.entry_ats[idx] {
        return Err(ServiceError::CosignMismatch(
            "метка времени head не совпадает с историей журнала".into(),
        ));
    }
    Ok(())
}

/// Запомнить косайн, если он новее уже известного от этого витнесса.
fn remember_cosign(inner: &mut Inner, cosign: HeadCosign) {
    match inner.cosigns.get(&cosign.witness) {
        Some(known) if known.head.size >= cosign.head.size => {}
        _ => {
            inner.cosigns.insert(cosign.witness, cosign);
        }
    }
}

// ---------- реализация портов contracts ----------

fn port_err(e: ServiceError) -> EconomyPortError {
    match e {
        ServiceError::Economy(EconomyError::AccountNotFound(_)) => {
            EconomyPortError::AccountNotFound
        }
        ServiceError::Economy(EconomyError::AccountAlreadyExists(_)) => {
            EconomyPortError::AccountAlreadyExists
        }
        ServiceError::Economy(e) => EconomyPortError::Rejected(e.to_string()),
        ServiceError::Store(e) => EconomyPortError::StorageUnavailable(e.to_string()),
        e @ (ServiceError::UnknownWitness | ServiceError::CosignMismatch(_)) => {
            EconomyPortError::Rejected(e.to_string())
        }
    }
}

impl EconomyAccountProvisioner for EconomyService {
    fn open_account(
        &self,
        account_uuid: Uuid,
        owner_key: [u8; 32],
    ) -> Result<EconomyAccountSummaryDto, EconomyPortError> {
        EconomyService::open_account(self, account_uuid, owner_key).map_err(port_err)
    }
}

impl EconomyReadPort for EconomyService {
    fn account_summary(
        &self,
        account_uuid: Uuid,
    ) -> Result<EconomyAccountSummaryDto, EconomyPortError> {
        let inner = self.lock_inner();
        self.account_summary_inner(&inner.state, account_uuid)
            .map_err(|e| port_err(ServiceError::Economy(e)))
    }

    fn commons_summary(&self) -> Result<CommonsSummaryDto, EconomyPortError> {
        let inner = self.lock_inner();
        Ok(CommonsSummaryDto {
            balance_grains: inner.state.commons_balance.0,
            total_issued_grains: inner.state.total_issued.0,
        })
    }

    fn ledger_head(&self) -> Result<LedgerHeadDto, EconomyPortError> {
        let head = self.head();
        Ok(LedgerHeadDto {
            size: head.size,
            last_entry_hash: to_hex(&head.last_entry_hash),
            merkle_root: to_hex(&head.merkle_root),
            at_ms: head.at.0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::{FixedLevelAttestor, InMemoryCosignStore, InMemoryLedgerStore};
    use flora_economy_crypto::amount::LIV_IN_GRAINS;
    use flora_economy_crypto::domain as tags;
    use flora_economy_crypto::ledger::transfer_signing_bytes;
    use flora_economy_crypto::sig::{public_key, sign};
    use flora_economy_crypto::witness::cosign_head;

    const ALICE_SEED: [u8; 32] = [11u8; 32];
    const BOB_SEED: [u8; 32] = [22u8; 32];
    const WITNESS_SEED: [u8; 32] = [77u8; 32];

    fn alice() -> Uuid {
        Uuid::from_u128(1)
    }
    fn bob() -> Uuid {
        Uuid::from_u128(2)
    }

    fn service(level: PersonhoodLevel) -> EconomyService {
        EconomyService::open(
            Arc::new(InMemoryLedgerStore::new()),
            Arc::new(InMemoryCosignStore::new()),
            vec![public_key(&WITNESS_SEED)],
            Arc::new(FixedLevelAttestor(level)),
        )
        .unwrap()
    }

    #[test]
    fn open_account_is_idempotent() {
        let svc = service(PersonhoodLevel::V1);
        let a = svc.open_account(alice(), public_key(&ALICE_SEED)).unwrap();
        let b = svc.open_account(alice(), public_key(&ALICE_SEED)).unwrap();
        assert_eq!(a, b);
        assert_eq!(svc.head().size, 2, "genesis + одно открытие");
    }

    #[test]
    fn ubi_requires_personhood_v1() {
        let svc = service(PersonhoodLevel::V0);
        svc.open_account(alice(), public_key(&ALICE_SEED)).unwrap();
        let err = svc.claim_ubi(alice()).unwrap_err();
        assert!(matches!(
            err,
            ServiceError::Economy(EconomyError::PersonhoodRequired)
        ));
    }

    #[test]
    fn ubi_then_signed_transfer_flows() {
        let svc = service(PersonhoodLevel::V1);
        svc.open_account(alice(), public_key(&ALICE_SEED)).unwrap();
        svc.open_account(bob(), public_key(&BOB_SEED)).unwrap();
        svc.claim_ubi(alice()).unwrap();

        let amount = Grains(100 * LIV_IN_GRAINS);
        let nonce = [1u8; 16];
        let payload = transfer_signing_bytes(
            &crate::domain::account_id_of(alice()),
            &crate::domain::account_id_of(bob()),
            amount,
            &nonce,
        );
        let signature = sign(tags::TRANSFER_AUTH, &payload, &ALICE_SEED);
        svc.transfer(alice(), bob(), amount, nonce, signature)
            .unwrap();

        let bob_summary = EconomyReadPort::account_summary(&svc, bob()).unwrap();
        assert_eq!(bob_summary.balance_grains, amount.0);
    }

    #[test]
    fn state_survives_restart_via_replay() {
        let store = Arc::new(InMemoryLedgerStore::new());
        let cosigns = Arc::new(InMemoryCosignStore::new());
        let witnesses = vec![public_key(&WITNESS_SEED)];
        let attestor = Arc::new(FixedLevelAttestor(PersonhoodLevel::V1));
        let head_before = {
            let svc = EconomyService::open(
                store.clone(),
                cosigns.clone(),
                witnesses.clone(),
                attestor.clone(),
            )
            .unwrap();
            svc.open_account(alice(), public_key(&ALICE_SEED)).unwrap();
            svc.claim_ubi(alice()).unwrap();
            // Витнесс подписывает head — косайн переживает рестарт.
            svc.submit_cosign(cosign_head(&svc.head(), &WITNESS_SEED))
                .unwrap();
            svc.head()
        };
        // «Рестарт»: новый сервис поверх того же журнала.
        let svc2 = EconomyService::open(store, cosigns, witnesses, attestor).unwrap();
        assert_eq!(svc2.head(), head_before);
        let summary = EconomyReadPort::account_summary(&svc2, alice()).unwrap();
        assert!(summary.balance_grains > 0);
        let (_, cosigns_after, _) = svc2.sth();
        assert_eq!(cosigns_after.len(), 1, "косайн реплеится из стора");
        assert_eq!(cosigns_after[0].head, head_before);
    }

    #[test]
    fn sweep_demurrage_writes_nothing_when_not_due() {
        let svc = service(PersonhoodLevel::V1);
        svc.open_account(alice(), public_key(&ALICE_SEED)).unwrap();
        svc.claim_ubi(alice()).unwrap();
        assert_eq!(svc.sweep_demurrage().unwrap(), 0);
    }

    #[test]
    fn inclusion_proof_verifies_against_head() {
        let svc = service(PersonhoodLevel::V1);
        svc.open_account(alice(), public_key(&ALICE_SEED)).unwrap();
        let entries = svc.entries(0, 100).unwrap();
        let (proof, head) = svc.inclusion_proof(1).unwrap();
        let leaf = merkle::hash_leaf(&entries[1].entry_hash());
        assert!(merkle::verify_inclusion(
            &leaf,
            1,
            head.size as usize,
            &proof,
            &head.merkle_root
        ));
    }

    #[test]
    fn cosign_accepts_current_and_historic_heads() {
        let svc = service(PersonhoodLevel::V1);
        let head_genesis = svc.head();
        svc.open_account(alice(), public_key(&ALICE_SEED)).unwrap();
        let head_after = svc.head();

        // Косайн текущего head.
        svc.submit_cosign(cosign_head(&head_after, &WITNESS_SEED))
            .unwrap();
        let (_, cosigns, witnesses) = svc.sth();
        assert_eq!(witnesses, vec![public_key(&WITNESS_SEED)]);
        assert_eq!(cosigns.len(), 1);
        assert_eq!(cosigns[0].head, head_after);

        // Косайн более раннего head валиден (витнесс отстаёт), но не затирает свежий.
        svc.submit_cosign(cosign_head(&head_genesis, &WITNESS_SEED))
            .unwrap();
        let (_, cosigns, _) = svc.sth();
        assert_eq!(cosigns.len(), 1);
        assert_eq!(cosigns[0].head, head_after, "свежий косайн сохранён");
    }

    #[test]
    fn cosign_from_unknown_witness_is_rejected() {
        let svc = service(PersonhoodLevel::V1);
        let stranger = cosign_head(&svc.head(), &[99u8; 32]);
        assert!(matches!(
            svc.submit_cosign(stranger),
            Err(ServiceError::UnknownWitness)
        ));
    }

    #[test]
    fn cosign_of_foreign_chain_is_rejected() {
        let svc = service(PersonhoodLevel::V1);
        // Голова «другого журнала»: тот же размер, другой корень.
        let mut forged = svc.head();
        forged.merkle_root = [0xEE; 32];
        let cosign = cosign_head(&forged, &WITNESS_SEED);
        assert!(matches!(
            svc.submit_cosign(cosign),
            Err(ServiceError::CosignMismatch(_))
        ));
        // Подделанная подпись.
        let mut bad_sig = cosign_head(&svc.head(), &WITNESS_SEED);
        bad_sig.signature[0] ^= 1;
        assert!(matches!(
            svc.submit_cosign(bad_sig),
            Err(ServiceError::Economy(EconomyError::InvalidSignature))
        ));
    }

    #[test]
    fn consistency_proof_links_two_heads() {
        let svc = service(PersonhoodLevel::V1);
        let old_head = svc.head();
        svc.open_account(alice(), public_key(&ALICE_SEED)).unwrap();
        svc.open_account(bob(), public_key(&BOB_SEED)).unwrap();
        svc.claim_ubi(alice()).unwrap();
        let new_head = svc.head();

        let slice = svc.consistency(old_head.size, None).unwrap();
        assert_eq!(slice.old_size, old_head.size);
        assert_eq!(slice.new_size, new_head.size);
        assert_eq!(slice.old_root, old_head.merkle_root);
        assert_eq!(slice.new_root, new_head.merkle_root);
        assert!(merkle::verify_consistency(
            slice.old_size,
            slice.new_size,
            &slice.old_root,
            &slice.new_root,
            &slice.proof,
        ));

        // Некорректные диапазоны.
        assert!(svc.consistency(0, None).is_none());
        assert!(svc.consistency(2, Some(1)).is_none());
        assert!(svc.consistency(1, Some(new_head.size + 1)).is_none());
    }
}
