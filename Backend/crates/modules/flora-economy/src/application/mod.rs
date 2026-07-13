//! Application-слой Economy: [`EconomyService`] — секвенсор журнала FEP.
//!
//! Единственный писатель: каждая операция строится как кандидат-запись, прогоняется через
//! движок ядра (все инварианты), при успехе — durable-append в хранилище и только затем
//! коммит состояния в памяти. Порядок «сначала диск, потом память» гарантирует, что память
//! никогда не впереди журнала (при сбое диска операция просто не произошла).
//!
//! Авторизация — криптографическая: переводы валидны подписью Ed25519 владельца, а не
//! HTTP-сессией. Сервис не доверяет вызывающему слою решать, «чей» это аккаунт.

use std::sync::{Arc, Mutex};

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
use flora_verification_contracts::{PersonhoodAttestor, PersonhoodLevel};
use uuid::Uuid;

use crate::domain::{account_id_of, sequencer_time, wall_clock_now_ms};
use crate::infrastructure::{LedgerStore, StoreError};

/// Ошибки application-слоя: экономические (ядро) либо инфраструктурные (хранилище).
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error(transparent)]
    Economy(#[from] EconomyError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Секвенсор FEP. Держит реплеенное состояние в памяти; журнал — источник истины.
pub struct EconomyService {
    store: Arc<dyn LedgerStore>,
    attestor: Arc<dyn PersonhoodAttestor>,
    state: Mutex<LedgerState>,
}

/// Результат применённой операции — для HTTP-ответов.
#[derive(Debug, Clone)]
pub struct AppliedEntry {
    pub seq: u64,
    pub entry_hash: Hash32,
    pub at: Timestamp,
}

impl EconomyService {
    /// Открыть сервис: реплей журнала из хранилища; пустое хранилище — записать genesis.
    pub fn open(
        store: Arc<dyn LedgerStore>,
        attestor: Arc<dyn PersonhoodAttestor>,
    ) -> Result<EconomyService, EconomyError> {
        let entries = store.load_all().map_err(|e| EconomyError::ReplayDiverged {
            expected: "читаемый журнал".into(),
            actual: e.to_string(),
        })?;
        let state = if entries.is_empty() {
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
            state
        } else {
            LedgerState::replay(&entries)?
        };
        Ok(EconomyService {
            store,
            attestor,
            state: Mutex::new(state),
        })
    }

    /// Общий путь всех операций: собрать запись при текущем head, применить к копии
    /// состояния (все инварианты), durable-append, коммит в память.
    fn sequence(&self, body: EntryBody) -> Result<AppliedEntry, ServiceError> {
        let mut state = self.state.lock().expect("mutex не отравлен");
        let at = sequencer_time(wall_clock_now_ms(), state.head.at);
        let entry = LedgerEntry {
            seq: state.head.size,
            at,
            prev_hash: state.head.last_entry_hash,
            body,
        };
        // Применяем к клону: при любой ошибке ни память, ни диск не меняются.
        let mut next = state.clone();
        next.apply(&entry)?;
        self.store.append(&entry)?;
        *state = next;
        Ok(AppliedEntry {
            seq: entry.seq,
            entry_hash: entry.entry_hash(),
            at,
        })
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
            let state = self.state.lock().expect("mutex не отравлен");
            if state.accounts.contains_key(&id) {
                return self
                    .account_summary_inner(&state, account_uuid)
                    .map_err(ServiceError::Economy);
            }
        }
        self.sequence(EntryBody::AccountOpened {
            account: id,
            owner_key,
        })?;
        let state = self.state.lock().expect("mutex не отравлен");
        self.account_summary_inner(&state, account_uuid)
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
            let state = self.state.lock().expect("mutex не отравлен");
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

    /// Перевод Pollen (подпись отправителя обязательна, проверяется ядром).
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
            let state = self.state.lock().expect("mutex не отравлен");
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

    // ---------- запросы ----------

    /// Текущий head журнала.
    pub fn head(&self) -> LedgerHead {
        self.state.lock().expect("mutex не отравлен").head.clone()
    }

    /// Текущие параметры.
    pub fn parameters(&self) -> Parameters {
        self.state.lock().expect("mutex не отравлен").params.clone()
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
        let state = self.state.lock().expect("mutex не отравлен");
        let leaves: Vec<Hash32> = state
            .entry_hashes
            .iter()
            .map(|h| merkle::hash_leaf(h))
            .collect();
        let proof = merkle::inclusion_proof(&leaves, seq as usize)?;
        Some((proof, state.head.clone()))
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
        let state = self.state.lock().expect("mutex не отравлен");
        self.account_summary_inner(&state, account_uuid)
            .map_err(|e| port_err(ServiceError::Economy(e)))
    }

    fn commons_summary(&self) -> Result<CommonsSummaryDto, EconomyPortError> {
        let state = self.state.lock().expect("mutex не отравлен");
        Ok(CommonsSummaryDto {
            balance_grains: state.commons_balance.0,
            total_issued_grains: state.total_issued.0,
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
    use crate::infrastructure::{FixedLevelAttestor, InMemoryLedgerStore};
    use flora_economy_crypto::amount::POLLEN_IN_GRAINS;
    use flora_economy_crypto::domain as tags;
    use flora_economy_crypto::ledger::transfer_signing_bytes;
    use flora_economy_crypto::sig::{public_key, sign};

    const ALICE_SEED: [u8; 32] = [11u8; 32];
    const BOB_SEED: [u8; 32] = [22u8; 32];

    fn alice() -> Uuid {
        Uuid::from_u128(1)
    }
    fn bob() -> Uuid {
        Uuid::from_u128(2)
    }

    fn service(level: PersonhoodLevel) -> EconomyService {
        EconomyService::open(
            Arc::new(InMemoryLedgerStore::new()),
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

        let amount = Grains(100 * POLLEN_IN_GRAINS);
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
        let attestor = Arc::new(FixedLevelAttestor(PersonhoodLevel::V1));
        let head_before = {
            let svc = EconomyService::open(store.clone(), attestor.clone()).unwrap();
            svc.open_account(alice(), public_key(&ALICE_SEED)).unwrap();
            svc.claim_ubi(alice()).unwrap();
            svc.head()
        };
        // «Рестарт»: новый сервис поверх того же журнала.
        let svc2 = EconomyService::open(store, attestor).unwrap();
        assert_eq!(svc2.head(), head_before);
        let summary = EconomyReadPort::account_summary(&svc2, alice()).unwrap();
        assert!(summary.balance_grains > 0);
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
}
