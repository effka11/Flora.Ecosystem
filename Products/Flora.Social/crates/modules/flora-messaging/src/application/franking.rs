//! Exclusive-claim очередь FSCP-FRANK. Сервер не видит plaintext / frankingKey.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{Duration, SecondsFormat, Utc};
use flora_auth_contracts::AccountDirectory;
use flora_messaging_contracts::{
    AccountBlockRequest, CreateFrankingReportRequest, ForwardFrankingReportRequest,
    FrankingAuditDto, FrankingAuditEvent, FrankingAuditEventDto, FrankingDisclosureDto,
    FrankingDisclosureWrapDto, FrankingOwnWrapDto, FrankingQueueDto, FrankingReportCategory,
    FrankingReportMetaDto, FrankingReportStatus, FrankingResolveDecision, FrankingServerKeyDto,
    FrankingVerificationStatus, PostFrankingWrapsRequest, ResolveFrankingReportRequest,
    ServerFrankReceiptDto,
};
use flora_shared::uuid_v5::dm_conversation_uuid;
use flora_users_contracts::AccountSanctions;
use uuid::Uuid;

use crate::infrastructure::franking::{
    FrankingRepo, InsertFrankReceipt, ReportRow, StoredFrankReceipt, WrapLock,
};

pub const MAX_VIEWER_ACCOUNTS: i64 = 5;
pub const MAX_REPORTS_PER_DAY: i64 = 20;
pub const QUEUE_PAGE_SIZE: i64 = 200;
pub const SIGNING_UNAVAILABLE_CODE: &str = "messaging.franking.signing_unavailable";
/// Срок бана при закрытии заявки: 1..=9999 суток либо «навсегда» (без `days`).
pub const MIN_ACCOUNT_BLOCK_DAYS: u32 = 1;
pub const MAX_ACCOUNT_BLOCK_DAYS: u32 = 9999;
const ACCOUNT_BLOCK_FOREVER_CODE: &str = "block-forever";

#[derive(Debug, Clone)]
pub enum FrankingError {
    BadRequest(String),
    NotFound(String),
    Forbidden(String),
    Conflict(String),
    TooManyRequests(String),
    Unavailable(String),
    Internal(String),
}

pub struct FrankingSigner {
    seed: [u8; 32],
    public_key: [u8; 32],
    key_id: Uuid,
}

impl FrankingSigner {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        let public_key = fscp_core::franking_public_key(&seed);
        let key_id = fscp_core::server_franking_key_id(&public_key);
        Self {
            seed,
            public_key,
            key_id,
        }
    }

    pub fn public_key(&self) -> &[u8; 32] {
        &self.public_key
    }

    pub fn key_id(&self) -> Uuid {
        self.key_id
    }

    pub fn sign(&self, ctx: &fscp_core::FrankReceiptContextV1) -> (String, [u8; 64]) {
        let payload = fscp_core::frank_receipt_payload_v1(ctx);
        let signature = fscp_core::sign_frank_receipt(&self.seed, &payload);
        (payload, signature)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaggedIngest {
    Untagged,
    Sign,
    FailClosed,
}

pub fn tagged_ingest_action(has_tag: bool, has_signer: bool) -> TaggedIngest {
    match (has_tag, has_signer) {
        (false, _) => TaggedIngest::Untagged,
        (true, true) => TaggedIngest::Sign,
        (true, false) => TaggedIngest::FailClosed,
    }
}

pub fn signing_unavailable_body() -> serde_json::Value {
    serde_json::json!({
        "error": "Подпись franking-квитанции недоступна.",
        "code": SIGNING_UNAVAILABLE_CODE,
    })
}

fn category_token(c: FrankingReportCategory) -> &'static str {
    match c {
        FrankingReportCategory::Abuse => "abuse",
        FrankingReportCategory::Threats => "threats",
        FrankingReportCategory::Spam => "spam",
        FrankingReportCategory::Csam => "csam",
        FrankingReportCategory::Other => "other",
    }
}

fn parse_category(s: &str) -> Option<FrankingReportCategory> {
    match s {
        "abuse" => Some(FrankingReportCategory::Abuse),
        "threats" => Some(FrankingReportCategory::Threats),
        "spam" => Some(FrankingReportCategory::Spam),
        "csam" => Some(FrankingReportCategory::Csam),
        "other" => Some(FrankingReportCategory::Other),
        _ => None,
    }
}

fn status_token(s: FrankingReportStatus) -> &'static str {
    match s {
        FrankingReportStatus::Open => "open",
        FrankingReportStatus::Claimed => "claimed",
        FrankingReportStatus::ClaimedAwaitingDisclosure => "claimed_awaiting_disclosure",
        FrankingReportStatus::Resolved => "resolved",
        FrankingReportStatus::Rejected => "rejected",
    }
}

fn parse_status(s: &str) -> Option<FrankingReportStatus> {
    match s {
        "open" => Some(FrankingReportStatus::Open),
        "claimed" => Some(FrankingReportStatus::Claimed),
        "claimed_awaiting_disclosure" => Some(FrankingReportStatus::ClaimedAwaitingDisclosure),
        "resolved" => Some(FrankingReportStatus::Resolved),
        "rejected" => Some(FrankingReportStatus::Rejected),
        _ => None,
    }
}

fn audit_token(e: FrankingAuditEvent) -> &'static str {
    match e {
        FrankingAuditEvent::WrapCreated => "wrap_created",
        FrankingAuditEvent::WrapDestroyed => "wrap_destroyed",
        FrankingAuditEvent::Claimed => "claimed",
        FrankingAuditEvent::Released => "released",
        FrankingAuditEvent::Forwarded => "forwarded",
        FrankingAuditEvent::DisclosureFetched => "disclosure_fetched",
        FrankingAuditEvent::Resolved => "resolved",
        FrankingAuditEvent::Rejected => "rejected",
    }
}

fn parse_audit_event(s: &str) -> Option<FrankingAuditEvent> {
    match s {
        "wrap_created" => Some(FrankingAuditEvent::WrapCreated),
        "wrap_destroyed" => Some(FrankingAuditEvent::WrapDestroyed),
        "claimed" => Some(FrankingAuditEvent::Claimed),
        "released" => Some(FrankingAuditEvent::Released),
        "forwarded" => Some(FrankingAuditEvent::Forwarded),
        "disclosure_fetched" => Some(FrankingAuditEvent::DisclosureFetched),
        "resolved" => Some(FrankingAuditEvent::Resolved),
        "rejected" => Some(FrankingAuditEvent::Rejected),
        _ => None,
    }
}

fn hidden_report() -> FrankingError {
    FrankingError::NotFound("Заявка не найдена.".into())
}

fn claim_blocked_for_party(caller: Uuid, reporter: Uuid, accused: Uuid) -> bool {
    caller == reporter || caller == accused
}

fn wrap_target_is_accused(target: Uuid, accused: Uuid) -> bool {
    target == accused
}

const PARTY_WRAP_MSG: &str = "viewer-wrap нельзя на сторону спора.";

fn map_wrap_write_err(error: String) -> FrankingError {
    match error.as_str() {
        "cap" => FrankingError::BadRequest("Кап зрителей заявки — 5 аккаунтов.".into()),
        "stale" => FrankingError::Conflict("Заявка изменилась, повторите запрос.".into()),
        "empty_wrap" => FrankingError::BadRequest("wrappedKey пуст.".into()),
        "closed" => FrankingError::Forbidden("Заявка закрыта.".into()),
        "party" => FrankingError::BadRequest(PARTY_WRAP_MSG.into()),
        "late_target" => FrankingError::BadRequest(
            "После подачи заявки viewer-wrap только на текущего claimerа.".into(),
        ),
        other => FrankingError::Internal(other.into()),
    }
}

fn wrap_lock_for_late(
    status: FrankingReportStatus,
    claimer: Option<Uuid>,
    prepared: &[(Uuid, Uuid, Vec<u8>)],
) -> WrapLock {
    let Some(c) = claimer else {
        return WrapLock::Unlocked;
    };
    if !prepared.iter().any(|(u, _, _)| *u == c) {
        return WrapLock::Unlocked;
    }
    match status {
        FrankingReportStatus::ClaimedAwaitingDisclosure => WrapLock::Claimer {
            claimer: c,
            promote: true,
        },
        FrankingReportStatus::Claimed => WrapLock::Claimer {
            claimer: c,
            promote: false,
        },
        _ => WrapLock::Unlocked,
    }
}

fn map_report_write_err(error: String) -> FrankingError {
    if error == "party" {
        return FrankingError::BadRequest(PARTY_WRAP_MSG.into());
    }
    if error == "quota" {
        return FrankingError::TooManyRequests("Превышен лимит жалоб за сутки.".into());
    }
    if error == "cap" {
        return FrankingError::BadRequest("Кап зрителей заявки — 5 аккаунтов.".into());
    }
    if error == "empty_wrap" || error.contains("ck_franking_disclosure_wraps_key") {
        return FrankingError::BadRequest("wrappedKey пуст.".into());
    }
    if error.contains("pk_franking_disclosure_wraps") {
        return FrankingError::BadRequest("wraps дублируют устройство.".into());
    }
    if error.contains("uq_franking_reports_live_reporter_message")
        || error.contains("uq_franking_reports_reporter_message")
        || error.contains("duplicate")
    {
        return FrankingError::Conflict("Жалоба на это сообщение уже есть.".into());
    }
    if error.contains("23503") || error.contains("fk_franking_reports_message") {
        return FrankingError::NotFound("Сообщение не найдено.".into());
    }
    FrankingError::Internal(error)
}

fn map_disclosure_err(error: String) -> FrankingError {
    match error.as_str() {
        "missing" => hidden_report(),
        "reporter" | "accused" => FrankingError::Forbidden("Нет доступа к наполнению.".into()),
        "closed" => FrankingError::Forbidden("Заявка закрыта.".into()),
        "open" => FrankingError::Forbidden("Наполнение доступно только после claim.".into()),
        "no_wrap" => {
            FrankingError::Forbidden("Нет viewer-wrap: ожидается раскрытие от жалобщика.".into())
        }
        "stale" => FrankingError::Conflict("Заявка изменилась, повторите запрос.".into()),
        other => FrankingError::Internal(other.into()),
    }
}

pub fn parse_franking_seed(raw: &str) -> Option<[u8; 32]> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
        }
        return Some(out);
    }
    URL_SAFE_NO_PAD.decode(s).ok()?.try_into().ok()
}

pub fn parse_reviewer_uuids(raw: &str) -> Result<Vec<Uuid>, String> {
    let mut uuids = Vec::new();
    let mut invalid = Vec::new();
    for part in raw.split([',', ';', ' ', '\n']) {
        let token = part.trim();
        if token.is_empty() {
            continue;
        }
        match Uuid::parse_str(token) {
            Ok(uuid) => uuids.push(uuid),
            Err(_) => invalid.push(token.to_string()),
        }
    }
    if !invalid.is_empty() {
        return Err(format!(
            "Messaging:FrankingReviewerUserUuids содержит невалидные UUID: {}",
            invalid.join(", ")
        ));
    }
    Ok(uuids)
}

#[cfg(test)]
pub fn viewer_account_count(wrap_users: &[Uuid], reporter: Uuid) -> usize {
    let mut seen = std::collections::HashSet::new();
    for u in wrap_users {
        if *u != reporter {
            seen.insert(*u);
        }
    }
    seen.len()
}

#[cfg(test)]
pub fn status_after_claim(has_claimer_wrap: bool) -> FrankingReportStatus {
    if has_claimer_wrap {
        FrankingReportStatus::Claimed
    } else {
        FrankingReportStatus::ClaimedAwaitingDisclosure
    }
}

/// Санкция, посчитанная до записи: срок (None — навсегда) и код резолюции.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AccountBlockPlan {
    blocked_until: Option<chrono::DateTime<Utc>>,
    resolution_code: String,
}

/// Решение о бане по телу `resolve`. Цель санкции — accused, её здесь нет:
/// функция чистая и знает только про решение, срок и часы.
///
/// `rejected` не банит никогда, даже с `accountBlock`; отсутствие `accountBlock` —
/// закрытие без санкции. Срок вне 1..=9999 — 400, заявка остаётся открытой.
fn plan_account_block(
    decision: FrankingResolveDecision,
    request: Option<&AccountBlockRequest>,
    now: chrono::DateTime<Utc>,
) -> Result<Option<AccountBlockPlan>, FrankingError> {
    if decision == FrankingResolveDecision::Rejected {
        return Ok(None);
    }
    let Some(request) = request else {
        return Ok(None);
    };
    let Some(days) = request.days else {
        return Ok(Some(AccountBlockPlan {
            blocked_until: None,
            resolution_code: ACCOUNT_BLOCK_FOREVER_CODE.to_string(),
        }));
    };
    if !(MIN_ACCOUNT_BLOCK_DAYS..=MAX_ACCOUNT_BLOCK_DAYS).contains(&days) {
        return Err(FrankingError::BadRequest(format!(
            "accountBlock.days: {MIN_ACCOUNT_BLOCK_DAYS}..={MAX_ACCOUNT_BLOCK_DAYS} суток."
        )));
    }
    Ok(Some(AccountBlockPlan {
        blocked_until: Some(now + Duration::days(i64::from(days))),
        resolution_code: format!("block-{days}d"),
    }))
}

pub struct FrankingService {
    repo: Arc<FrankingRepo>,
    signer: Option<Arc<FrankingSigner>>,
    reviewer_roster_ready: AtomicBool,
    accounts: Arc<dyn AccountDirectory>,
    /// Право записи санкции есть только у модерации — отсюда и закрывают заявки.
    sanctions: Arc<dyn AccountSanctions>,
}

impl FrankingService {
    pub fn new(
        repo: Arc<FrankingRepo>,
        signer: Option<Arc<FrankingSigner>>,
        accounts: Arc<dyn AccountDirectory>,
        sanctions: Arc<dyn AccountSanctions>,
    ) -> Self {
        Self {
            repo,
            signer,
            reviewer_roster_ready: AtomicBool::new(true),
            accounts,
            sanctions,
        }
    }

    pub fn mark_reviewer_roster_unready(&self) {
        self.reviewer_roster_ready.store(false, Ordering::SeqCst);
    }

    pub fn signer(&self) -> Option<Arc<FrankingSigner>> {
        self.signer.clone()
    }

    pub async fn merge_reviewers(&self, uuids: &[Uuid]) -> Result<(), String> {
        self.repo.upsert_reviewers(uuids).await
    }

    pub fn server_key(&self) -> FrankingServerKeyDto {
        match self.signer.as_ref() {
            Some(signer) => FrankingServerKeyDto {
                server_franking_key_id: Some(signer.key_id()),
                public_key_base64_url: Some(URL_SAFE_NO_PAD.encode(signer.public_key())),
            },
            None => FrankingServerKeyDto {
                server_franking_key_id: None,
                public_key_base64_url: None,
            },
        }
    }

    pub async fn create_report(
        &self,
        reporter: Uuid,
        body: CreateFrankingReportRequest,
    ) -> Result<FrankingReportMetaDto, FrankingError> {
        let decoded = decode_b64u_limited(&body.disclosure_ciphertext, 262_144)
            .map_err(FrankingError::BadRequest)?;
        if decoded.is_empty() {
            return Err(FrankingError::BadRequest(
                "disclosureCiphertext обязателен.".into(),
            ));
        }

        let since = Utc::now() - Duration::hours(24);
        let recent = self
            .repo
            .reports_created_since(reporter, since)
            .await
            .map_err(FrankingError::Internal)?;
        if recent >= MAX_REPORTS_PER_DAY {
            return Err(FrankingError::TooManyRequests(
                "Превышен лимит жалоб за сутки.".into(),
            ));
        }

        let Some(msg) = self
            .repo
            .message_participants(body.persisted_message_uuid)
            .await
            .map_err(FrankingError::Internal)?
        else {
            return Err(FrankingError::NotFound("Сообщение не найдено.".into()));
        };
        if msg.receiver_user_uuid != reporter {
            if msg.sender_user_uuid == reporter {
                return Err(FrankingError::Forbidden(
                    "Жалобу может подать только получатель сообщения.".into(),
                ));
            }
            return Err(FrankingError::NotFound("Сообщение не найдено.".into()));
        }

        let conversation_uuid =
            dm_conversation_uuid(&msg.sender_user_uuid, &msg.receiver_user_uuid);
        let wire = self
            .repo
            .extract_wire_message_uuid(body.persisted_message_uuid, reporter)
            .await
            .map_err(FrankingError::Internal)?;
        let wire_message_uuid = wire
            .as_deref()
            .and_then(|w| fscp_core::extract_message_uuid(w).ok())
            .unwrap_or(body.persisted_message_uuid);

        let roster = self
            .repo
            .active_reviewer_uuids()
            .await
            .map_err(FrankingError::Internal)?;
        let wraps = self
            .validate_submit_wraps(reporter, msg.sender_user_uuid, &roster, &body.wraps)
            .await?;

        let now = Utc::now();
        let report_uuid = Uuid::now_v7();
        let row = ReportRow {
            report_uuid,
            persisted_message_uuid: body.persisted_message_uuid,
            wire_message_uuid,
            conversation_uuid,
            reporter_user_uuid: reporter,
            accused_user_uuid: msg.sender_user_uuid,
            category: category_token(body.category).to_string(),
            status: status_token(FrankingReportStatus::Open).to_string(),
            claimed_by: None,
            claimed_at: None,
            has_disclosure: true,
            created_at: now,
        };

        let mut audit = Vec::new();
        for (user, _, _) in &wraps {
            audit.push((
                audit_token(FrankingAuditEvent::WrapCreated).to_string(),
                reporter,
                Some(*user),
            ));
        }

        match self
            .repo
            .insert_report(
                &row,
                &decoded,
                &wraps,
                &audit,
                MAX_REPORTS_PER_DAY,
                MAX_VIEWER_ACCOUNTS,
            )
            .await
        {
            Ok(()) => {}
            Err(e) => return Err(map_report_write_err(e)),
        }

        self.meta_from_row_for(reporter, &row).await
    }

    pub async fn get_report(
        &self,
        caller: Uuid,
        report_uuid: Uuid,
    ) -> Result<FrankingReportMetaDto, FrankingError> {
        let row = self.require_report_known_to(caller, report_uuid).await?;
        self.meta_from_row_for(caller, &row).await
    }

    pub async fn queue(
        &self,
        caller: Uuid,
        cursor: Option<&str>,
    ) -> Result<FrankingQueueDto, FrankingError> {
        self.require_reviewer(caller).await?;
        let after = decode_queue_cursor(cursor)?;
        let mut rows = self
            .repo
            .list_queue(QUEUE_PAGE_SIZE + 1, caller, after)
            .await
            .map_err(FrankingError::Internal)?;
        let has_more = rows.len() as i64 > QUEUE_PAGE_SIZE;
        if has_more {
            rows.truncate(QUEUE_PAGE_SIZE as usize);
        }
        let next_cursor = if has_more {
            rows.last()
                .map(|r| encode_queue_cursor(r.created_at, r.report_uuid))
        } else {
            None
        };
        let report_ids: Vec<Uuid> = rows.iter().map(|r| r.report_uuid).collect();
        let message_ids: Vec<Uuid> = rows.iter().map(|r| r.persisted_message_uuid).collect();
        let counts = self
            .repo
            .viewer_counts_for_reports(&report_ids)
            .await
            .map_err(FrankingError::Internal)?;
        let receipts = self
            .repo
            .receipts_by_message_uuids(&message_ids)
            .await
            .map_err(FrankingError::Internal)?;
        let receipts_by_msg: HashMap<Uuid, StoredFrankReceipt> =
            receipts.into_iter().map(|r| (r.message_uuid, r)).collect();
        let mut party_ids = Vec::with_capacity(rows.len() * 2);
        for row in &rows {
            party_ids.push(row.reporter_user_uuid);
            party_ids.push(row.accused_user_uuid);
        }
        party_ids.sort_unstable();
        party_ids.dedup();
        let usernames = self.usernames_map(&party_ids).await?;
        let mut items = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut meta = report_meta(
                row,
                counts.get(&row.report_uuid).copied().unwrap_or(0),
                receipts_by_msg.get(&row.persisted_message_uuid),
                username_from_map(&usernames, row.reporter_user_uuid),
                username_from_map(&usernames, row.accused_user_uuid),
            )?;
            hide_claimer_from_reporter(caller, row.reporter_user_uuid, meta.status, &mut meta);
            items.push(meta);
        }
        Ok(FrankingQueueDto {
            items,
            next_cursor,
            has_more,
        })
    }

    pub async fn claim(
        &self,
        caller: Uuid,
        report_uuid: Uuid,
    ) -> Result<FrankingReportMetaDto, FrankingError> {
        let row = self.require_report_known_to(caller, report_uuid).await?;
        self.require_reviewer(caller).await?;
        if claim_blocked_for_party(caller, row.reporter_user_uuid, row.accused_user_uuid) {
            return Err(FrankingError::Forbidden(
                "Сторона спора не может claim.".into(),
            ));
        }
        if row.status != status_token(FrankingReportStatus::Open) {
            return Err(FrankingError::Conflict("Заявка уже занята.".into()));
        }
        let now = Utc::now();
        let ok = self
            .repo
            .claim_open(report_uuid, caller, row.reporter_user_uuid, now)
            .await
            .map_err(FrankingError::Internal)?;
        if !ok {
            return Err(FrankingError::Conflict("Заявка уже занята.".into()));
        }
        let updated = self.require_report(report_uuid).await?;
        self.meta_from_row_for(caller, &updated).await
    }

    pub async fn release(
        &self,
        caller: Uuid,
        report_uuid: Uuid,
    ) -> Result<FrankingReportMetaDto, FrankingError> {
        let row = self.require_report_known_to(caller, report_uuid).await?;
        if row.claimed_by != Some(caller) {
            return Err(FrankingError::Forbidden(
                "Только claimer может освободить заявку.".into(),
            ));
        }
        let ok = self
            .repo
            .release(report_uuid, caller, row.reporter_user_uuid, Utc::now())
            .await
            .map_err(FrankingError::Internal)?;
        if !ok {
            return Err(FrankingError::Conflict("Заявку нельзя освободить.".into()));
        }
        let updated = self.require_report(report_uuid).await?;
        self.meta_from_row_for(caller, &updated).await
    }

    pub async fn add_wraps(
        &self,
        caller: Uuid,
        report_uuid: Uuid,
        body: PostFrankingWrapsRequest,
    ) -> Result<FrankingReportMetaDto, FrankingError> {
        let row = self.require_report_known_to(caller, report_uuid).await?;
        if row.reporter_user_uuid != caller {
            return Err(hidden_report());
        }
        let status = parse_status(&row.status)
            .ok_or_else(|| FrankingError::Internal("bad status".into()))?;
        if matches!(
            status,
            FrankingReportStatus::Resolved | FrankingReportStatus::Rejected
        ) {
            return Err(FrankingError::Forbidden("Заявка закрыта.".into()));
        }
        let claimer = row.claimed_by;
        let mut prepared = Vec::new();
        for w in &body.wraps {
            let bytes = decode_wrap_key(&w.wrapped_key)?;
            if w.user_uuid == caller {
                self.require_active_device(w.user_uuid, w.device_uuid)
                    .await?;
                prepared.push((w.user_uuid, w.device_uuid, bytes));
                continue;
            }
            match (status, claimer) {
                (
                    FrankingReportStatus::Claimed | FrankingReportStatus::ClaimedAwaitingDisclosure,
                    Some(c),
                ) if w.user_uuid == c => {
                    self.require_active_device(w.user_uuid, w.device_uuid)
                        .await?;
                    prepared.push((w.user_uuid, w.device_uuid, bytes));
                }
                _ => {
                    return Err(FrankingError::BadRequest(
                        "После подачи заявки viewer-wrap только на текущего claimerа.".into(),
                    ));
                }
            }
        }
        if prepared.is_empty() {
            return Err(FrankingError::BadRequest("wraps пуст.".into()));
        }
        let lock = wrap_lock_for_late(status, claimer, &prepared);
        self.repo
            .insert_wraps(
                report_uuid,
                &prepared,
                caller,
                audit_token(FrankingAuditEvent::WrapCreated),
                Utc::now(),
                lock,
            )
            .await
            .map_err(map_wrap_write_err)?;
        let updated = self.require_report(report_uuid).await?;
        self.meta_from_row_for(caller, &updated).await
    }

    pub async fn disclosure(
        &self,
        caller: Uuid,
        report_uuid: Uuid,
    ) -> Result<FrankingDisclosureDto, FrankingError> {
        let row = self.require_report_known_to(caller, report_uuid).await?;
        if claim_blocked_for_party(caller, row.reporter_user_uuid, row.accused_user_uuid) {
            return Err(FrankingError::Forbidden("Нет доступа к наполнению.".into()));
        }
        let fetched = self
            .repo
            .fetch_disclosure(report_uuid, caller, Utc::now())
            .await
            .map_err(map_disclosure_err)?;
        let (server_frank_receipt, frank_tag_base64_url, verification_status) =
            receipt_dto(fetched.receipt.as_ref());
        Ok(FrankingDisclosureDto {
            disclosure_ciphertext: URL_SAFE_NO_PAD.encode(&fetched.ciphertext),
            wraps: fetched
                .wraps
                .into_iter()
                .map(|w| FrankingOwnWrapDto {
                    device_uuid: w.device_uuid,
                    wrapped_key: URL_SAFE_NO_PAD.encode(&w.wrapped_key),
                })
                .collect(),
            server_frank_receipt,
            frank_tag_base64_url,
            verification_status,
        })
    }

    pub async fn forward(
        &self,
        caller: Uuid,
        report_uuid: Uuid,
        body: ForwardFrankingReportRequest,
    ) -> Result<FrankingReportMetaDto, FrankingError> {
        let row = self.require_report_known_to(caller, report_uuid).await?;
        if row.claimed_by != Some(caller)
            || row.status != status_token(FrankingReportStatus::Claimed)
        {
            return Err(FrankingError::Forbidden(
                "Переслать может только claimer из статуса claimed.".into(),
            ));
        }
        let mut prepared = Vec::new();
        for w in &body.wraps {
            if w.user_uuid == row.reporter_user_uuid
                || wrap_target_is_accused(w.user_uuid, row.accused_user_uuid)
            {
                return Err(FrankingError::BadRequest(PARTY_WRAP_MSG.into()));
            }
            if w.user_uuid == caller {
                return Err(FrankingError::BadRequest(
                    "Forward только на другого ревьюера.".into(),
                ));
            }
            self.require_forward_target(w.user_uuid).await?;
            self.require_active_device(w.user_uuid, w.device_uuid)
                .await?;
            let bytes = decode_wrap_key(&w.wrapped_key)?;
            prepared.push((w.user_uuid, w.device_uuid, bytes));
        }
        if prepared.is_empty() {
            return Err(FrankingError::BadRequest("wraps пуст.".into()));
        }
        self.repo
            .insert_wraps(
                report_uuid,
                &prepared,
                caller,
                audit_token(FrankingAuditEvent::Forwarded),
                Utc::now(),
                WrapLock::ForwardCap {
                    reporter: row.reporter_user_uuid,
                    claimer: caller,
                    max: MAX_VIEWER_ACCOUNTS,
                },
            )
            .await
            .map_err(map_wrap_write_err)?;
        let updated = self.require_report(report_uuid).await?;
        self.meta_from_row_for(caller, &updated).await
    }

    pub async fn resolve(
        &self,
        caller: Uuid,
        report_uuid: Uuid,
        body: ResolveFrankingReportRequest,
    ) -> Result<FrankingReportMetaDto, FrankingError> {
        let row = self.require_report_known_to(caller, report_uuid).await?;
        let live = parse_status(&row.status).is_some_and(|status| {
            matches!(
                status,
                FrankingReportStatus::Claimed | FrankingReportStatus::ClaimedAwaitingDisclosure
            )
        });
        if row.claimed_by != Some(caller) || !live {
            return Err(FrankingError::Forbidden(
                "Закрыть может только claimer живой заявки.".into(),
            ));
        }
        let status = match body.decision {
            FrankingResolveDecision::Resolved => "resolved",
            FrankingResolveDecision::Rejected => "rejected",
        };
        let code = body
            .code
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(c) = code
            && (c.len() > 64
                || c.chars()
                    .any(|ch| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')))
        {
            return Err(FrankingError::BadRequest(
                "resolution code: до 64 ascii [A-Za-z0-9_-].".into(),
            ));
        }
        let now = Utc::now();
        let block = plan_account_block(body.decision, body.account_block.as_ref(), now)?;
        // Санкция — итог разбора, поэтому её код сильнее клиентского.
        let code = match &block {
            Some(plan) => Some(plan.resolution_code.as_str()),
            None => code,
        };
        // Порядок заморожен: сперва бан, потом закрытие. Обратный порядок оставил
        // бы «разобранную» заявку с неотбанненным accused, если запись санкции упадёт.
        if let Some(plan) = &block {
            self.apply_account_block(&row, caller, plan).await?;
        }
        let ok = self
            .repo
            .resolve(report_uuid, caller, status, code, now)
            .await
            .map_err(FrankingError::Internal)?;
        if !ok {
            return Err(FrankingError::Conflict("Заявку нельзя закрыть.".into()));
        }
        let updated = self.require_report(report_uuid).await?;
        self.meta_from_row_for(caller, &updated).await
    }

    pub async fn audit(
        &self,
        caller: Uuid,
        report_uuid: Uuid,
    ) -> Result<FrankingAuditDto, FrankingError> {
        let row = self.require_report_known_to(caller, report_uuid).await?;
        if claim_blocked_for_party(caller, row.reporter_user_uuid, row.accused_user_uuid) {
            return Err(FrankingError::Forbidden(
                "Сторона спора не может смотреть аудит.".into(),
            ));
        }
        let status = parse_status(&row.status)
            .ok_or_else(|| FrankingError::Internal("bad status".into()))?;
        let on_report = match status {
            FrankingReportStatus::Open => {
                self.require_reviewer(caller).await?;
                true
            }
            _ => row.claimed_by == Some(caller) || self.has_viewer_capability(&row, caller).await?,
        };
        if !on_report {
            return Err(FrankingError::Forbidden(
                "Аудит доступен ревьюерам этой заявки.".into(),
            ));
        }
        let events = self
            .repo
            .list_audit(report_uuid)
            .await
            .map_err(FrankingError::Internal)?;
        let viewer_account_count = self
            .repo
            .viewer_account_count(report_uuid, row.reporter_user_uuid)
            .await
            .map_err(FrankingError::Internal)?;
        let mut dto_events = Vec::with_capacity(events.len());
        for e in events {
            dto_events.push(FrankingAuditEventDto {
                audit_uuid: e.audit_uuid,
                event: parse_audit_event(&e.event)
                    .ok_or_else(|| FrankingError::Internal("bad audit event".into()))?,
                actor_user_uuid: e.actor_user_uuid,
                subject_user_uuid: e.subject_user_uuid,
                created_at: format_utc(e.created_at),
            });
        }
        Ok(FrankingAuditDto {
            viewer_account_count,
            events: dto_events,
        })
    }

    pub async fn receipts_map(
        &self,
        ids: &[Uuid],
    ) -> Result<std::collections::HashMap<Uuid, (ServerFrankReceiptDto, String)>, String> {
        let rows = self.repo.receipts_by_message_uuids(ids).await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let id = r.message_uuid;
                (id, receipt_to_dto(&r))
            })
            .collect())
    }

    /// Санкция всегда ложится на accused из строки заявки — не на жалобщика и
    /// не на вызывающего; автором записи становится закрывающий ревьюер.
    async fn apply_account_block(
        &self,
        row: &ReportRow,
        caller: Uuid,
        plan: &AccountBlockPlan,
    ) -> Result<(), FrankingError> {
        self.sanctions
            .apply_block(row.accused_user_uuid, plan.blocked_until, caller)
            .await
            .map_err(FrankingError::Internal)
    }

    async fn validate_submit_wraps(
        &self,
        reporter: Uuid,
        accused: Uuid,
        roster: &[Uuid],
        wraps: &[FrankingDisclosureWrapDto],
    ) -> Result<Vec<(Uuid, Uuid, Vec<u8>)>, FrankingError> {
        let mut prepared = Vec::new();
        let mut viewers = std::collections::HashSet::new();
        let mut devices = std::collections::HashSet::new();
        for w in wraps {
            let bytes = decode_wrap_key(&w.wrapped_key)?;
            if !devices.insert((w.user_uuid, w.device_uuid)) {
                return Err(FrankingError::BadRequest(
                    "wraps дублируют устройство.".into(),
                ));
            }
            self.require_active_device(w.user_uuid, w.device_uuid)
                .await?;
            if w.user_uuid == reporter {
                prepared.push((w.user_uuid, w.device_uuid, bytes));
                continue;
            }
            if wrap_target_is_accused(w.user_uuid, accused) {
                return Err(FrankingError::BadRequest(PARTY_WRAP_MSG.into()));
            }
            if !roster.contains(&w.user_uuid) {
                return Err(FrankingError::BadRequest(
                    "viewer-wrap только на активного ревьюера.".into(),
                ));
            }
            viewers.insert(w.user_uuid);
            prepared.push((w.user_uuid, w.device_uuid, bytes));
        }
        if viewers.len() as i64 > MAX_VIEWER_ACCOUNTS {
            return Err(FrankingError::BadRequest(
                "Кап зрителей заявки — 5 аккаунтов.".into(),
            ));
        }
        Ok(prepared)
    }

    async fn has_viewer_capability(
        &self,
        row: &ReportRow,
        user_uuid: Uuid,
    ) -> Result<bool, FrankingError> {
        if user_uuid == row.reporter_user_uuid || user_uuid == row.accused_user_uuid {
            return Ok(false);
        }
        self.repo
            .has_viewer_wrap(row.report_uuid, user_uuid)
            .await
            .map_err(FrankingError::Internal)
    }

    async fn require_active_device(
        &self,
        user_uuid: Uuid,
        device_uuid: Uuid,
    ) -> Result<(), FrankingError> {
        let ok = self
            .repo
            .has_active_device(user_uuid, device_uuid)
            .await
            .map_err(FrankingError::Internal)?;
        if !ok {
            return Err(FrankingError::BadRequest(
                "deviceUuid не принадлежит активному устройству пользователя.".into(),
            ));
        }
        Ok(())
    }

    async fn require_reviewer(&self, user_uuid: Uuid) -> Result<(), FrankingError> {
        if !self.reviewer_roster_ready.load(Ordering::SeqCst) {
            return Err(FrankingError::Unavailable(
                "Список franking-ревьюеров не загружен.".into(),
            ));
        }
        let ok = self
            .repo
            .is_active_reviewer(user_uuid)
            .await
            .map_err(FrankingError::Internal)?;
        if !ok {
            return Err(FrankingError::Forbidden(
                "Нужна роль franking-ревьюера.".into(),
            ));
        }
        Ok(())
    }

    async fn require_forward_target(&self, user_uuid: Uuid) -> Result<(), FrankingError> {
        if !self.reviewer_roster_ready.load(Ordering::SeqCst) {
            return Err(FrankingError::Unavailable(
                "Список franking-ревьюеров не загружен.".into(),
            ));
        }
        let ok = self
            .repo
            .is_active_reviewer(user_uuid)
            .await
            .map_err(FrankingError::Internal)?;
        if !ok {
            return Err(FrankingError::BadRequest(
                "viewer-wrap только на активного ревьюера.".into(),
            ));
        }
        Ok(())
    }

    async fn require_report(&self, report_uuid: Uuid) -> Result<ReportRow, FrankingError> {
        self.repo
            .get_report(report_uuid)
            .await
            .map_err(FrankingError::Internal)?
            .ok_or_else(hidden_report)
    }

    async fn require_report_known_to(
        &self,
        caller: Uuid,
        report_uuid: Uuid,
    ) -> Result<ReportRow, FrankingError> {
        let found = self
            .repo
            .get_report(report_uuid)
            .await
            .map_err(FrankingError::Internal)?;
        let ready = self.reviewer_roster_ready.load(Ordering::SeqCst);
        if let Some(row) = found {
            if caller == row.reporter_user_uuid || row.claimed_by == Some(caller) {
                return Ok(row);
            }
            if self.has_viewer_capability(&row, caller).await? {
                return Ok(row);
            }
            if !ready {
                return Err(FrankingError::Unavailable(
                    "Список franking-ревьюеров не загружен.".into(),
                ));
            }
            if caller == row.accused_user_uuid {
                return Err(hidden_report());
            }
            let ok = self
                .repo
                .is_active_reviewer(caller)
                .await
                .map_err(FrankingError::Internal)?;
            if !ok {
                return Err(hidden_report());
            }
            return Ok(row);
        }
        if !ready {
            return Err(FrankingError::Unavailable(
                "Список franking-ревьюеров не загружен.".into(),
            ));
        }
        Err(hidden_report())
    }

    async fn usernames_map(&self, ids: &[Uuid]) -> Result<HashMap<Uuid, String>, FrankingError> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let pairs = self
            .accounts
            .usernames_by_uuids(ids)
            .await
            .map_err(FrankingError::Internal)?;
        Ok(pairs
            .into_iter()
            .filter_map(|(id, name)| {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some((id, trimmed.to_string()))
                }
            })
            .collect())
    }

    async fn meta_from_row(&self, row: &ReportRow) -> Result<FrankingReportMetaDto, FrankingError> {
        let viewer_account_count = self
            .repo
            .viewer_account_count(row.report_uuid, row.reporter_user_uuid)
            .await
            .map_err(FrankingError::Internal)?;
        let receipt = self
            .repo
            .receipt_for_message(row.persisted_message_uuid)
            .await
            .map_err(FrankingError::Internal)?;
        let usernames = self
            .usernames_map(&[row.reporter_user_uuid, row.accused_user_uuid])
            .await?;
        report_meta(
            row,
            viewer_account_count,
            receipt.as_ref(),
            username_from_map(&usernames, row.reporter_user_uuid),
            username_from_map(&usernames, row.accused_user_uuid),
        )
    }

    async fn meta_from_row_for(
        &self,
        caller: Uuid,
        row: &ReportRow,
    ) -> Result<FrankingReportMetaDto, FrankingError> {
        let mut meta = self.meta_from_row(row).await?;
        hide_claimer_from_reporter(caller, row.reporter_user_uuid, meta.status, &mut meta);
        Ok(meta)
    }
}

fn hide_claimer_from_reporter(
    caller: Uuid,
    reporter: Uuid,
    status: FrankingReportStatus,
    meta: &mut FrankingReportMetaDto,
) {
    if caller != reporter {
        return;
    }
    if status == FrankingReportStatus::ClaimedAwaitingDisclosure {
        return;
    }
    meta.claimed_by = None;
    meta.claimed_at = None;
}

fn username_from_map(map: &HashMap<Uuid, String>, user: Uuid) -> Option<String> {
    map.get(&user).cloned()
}

fn report_meta(
    row: &ReportRow,
    viewer_account_count: i64,
    receipt: Option<&StoredFrankReceipt>,
    reporter_username: Option<String>,
    accused_username: Option<String>,
) -> Result<FrankingReportMetaDto, FrankingError> {
    let verification_status = if receipt.is_some() {
        FrankingVerificationStatus::Verifiable
    } else {
        FrankingVerificationStatus::Unverifiable
    };
    Ok(FrankingReportMetaDto {
        report_uuid: row.report_uuid,
        persisted_message_uuid: row.persisted_message_uuid,
        conversation_uuid: row.conversation_uuid,
        category: parse_category(&row.category)
            .ok_or_else(|| FrankingError::Internal("bad category".into()))?,
        status: parse_status(&row.status)
            .ok_or_else(|| FrankingError::Internal("bad status".into()))?,
        claimed_by: row.claimed_by,
        claimed_at: row.claimed_at.map(format_utc),
        created_at: format_utc(row.created_at),
        viewer_account_count,
        has_disclosure: row.has_disclosure,
        verification_status,
        reporter_username,
        accused_username,
    })
}

pub fn receipt_to_dto(row: &StoredFrankReceipt) -> (ServerFrankReceiptDto, String) {
    (
        ServerFrankReceiptDto {
            signature_base64_url: URL_SAFE_NO_PAD.encode(&row.signature),
            server_franking_key_id: row.key_id,
            server_received_at: signed_server_received_at(&row.receipt_payload)
                .unwrap_or_else(|| format_utc(row.server_received_at)),
        },
        URL_SAFE_NO_PAD.encode(&row.frank_tag),
    )
}

fn signed_server_received_at(payload: &str) -> Option<String> {
    if !payload.starts_with(fscp_core::FSCP_FRANKING_RECEIPT_CONTEXT_V1) {
        return None;
    }
    payload
        .rsplit_once(" | ")
        .map(|(_, ts)| ts.to_string())
        .filter(|ts| !ts.is_empty())
}

fn receipt_dto(
    row: Option<&StoredFrankReceipt>,
) -> (
    Option<ServerFrankReceiptDto>,
    Option<String>,
    FrankingVerificationStatus,
) {
    match row {
        Some(r) => {
            let (dto, tag) = receipt_to_dto(r);
            (Some(dto), Some(tag), FrankingVerificationStatus::Verifiable)
        }
        None => (None, None, FrankingVerificationStatus::Unverifiable),
    }
}

fn decode_wrap_key(s: &str) -> Result<Vec<u8>, FrankingError> {
    let bytes = decode_b64u_limited(s, 8192).map_err(FrankingError::BadRequest)?;
    if bytes.is_empty() {
        return Err(FrankingError::BadRequest("wrappedKey пуст.".into()));
    }
    Ok(bytes)
}

fn decode_b64u_limited(s: &str, max: usize) -> Result<Vec<u8>, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(s.trim())
        .map_err(|_| "некорректный base64url.".to_string())?;
    if bytes.len() > max {
        return Err(format!("превышен лимит {max} байт."));
    }
    Ok(bytes)
}

fn format_utc(dt: chrono::DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn encode_queue_cursor(created_at: chrono::DateTime<Utc>, report_uuid: Uuid) -> String {
    URL_SAFE_NO_PAD.encode(
        format!(
            "{}|{report_uuid}",
            created_at.to_rfc3339_opts(SecondsFormat::Micros, true)
        )
        .as_bytes(),
    )
}

fn decode_queue_cursor(
    cursor: Option<&str>,
) -> Result<Option<(chrono::DateTime<Utc>, Uuid)>, FrankingError> {
    let Some(raw) = cursor.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| FrankingError::BadRequest("некорректный cursor.".into()))?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| FrankingError::BadRequest("некорректный cursor.".into()))?;
    let (ts, id) = text
        .rsplit_once('|')
        .ok_or_else(|| FrankingError::BadRequest("некорректный cursor.".into()))?;
    let created_at = chrono::DateTime::parse_from_rfc3339(ts)
        .map_err(|_| FrankingError::BadRequest("некорректный cursor.".into()))?
        .with_timezone(&Utc);
    let report_uuid = Uuid::parse_str(id)
        .map_err(|_| FrankingError::BadRequest("некорректный cursor.".into()))?;
    Ok(Some((created_at, report_uuid)))
}

#[allow(clippy::too_many_arguments)]
pub fn build_insert_receipt(
    signer: &FrankingSigner,
    persisted_message_uuid: Uuid,
    wire_message_uuid: Uuid,
    conversation_uuid: Uuid,
    sender_user_uuid: Uuid,
    receiver_user_uuid: Uuid,
    frank_tag: [u8; 32],
    server_received_at: chrono::DateTime<Utc>,
) -> InsertFrankReceipt {
    let server_received_at_str = format_utc(server_received_at);
    let ctx = fscp_core::FrankReceiptContextV1 {
        frank_tag_base64_url: URL_SAFE_NO_PAD.encode(frank_tag),
        message_uuid: wire_message_uuid,
        conversation_uuid,
        sender_user_uuid,
        receiver_user_uuid,
        server_received_at: server_received_at_str,
    };
    let (payload, signature) = signer.sign(&ctx);
    InsertFrankReceipt {
        message_uuid: persisted_message_uuid,
        wire_message_uuid,
        frank_tag,
        receipt_payload: payload,
        signature,
        key_id: signer.key_id(),
        server_received_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewer_count_excludes_reporter() {
        let reporter = Uuid::from_u128(1);
        let a = Uuid::from_u128(2);
        let b = Uuid::from_u128(3);
        assert_eq!(
            viewer_account_count(&[reporter, a, a, reporter], reporter),
            1
        );
        assert_eq!(viewer_account_count(&[a, b], reporter), 2);
        assert_eq!(viewer_account_count(&[reporter], reporter), 0);
    }

    #[test]
    fn claim_status_depends_on_wrap() {
        assert_eq!(status_after_claim(true), FrankingReportStatus::Claimed);
        assert_eq!(
            status_after_claim(false),
            FrankingReportStatus::ClaimedAwaitingDisclosure
        );
    }

    #[test]
    fn party_cannot_claim() {
        let reporter = Uuid::from_u128(1);
        let accused = Uuid::from_u128(2);
        let reviewer = Uuid::from_u128(3);
        assert!(claim_blocked_for_party(reporter, reporter, accused));
        assert!(claim_blocked_for_party(accused, reporter, accused));
        assert!(!claim_blocked_for_party(reviewer, reporter, accused));
        assert!(wrap_target_is_accused(accused, accused));
        assert!(!wrap_target_is_accused(reviewer, accused));
        assert!(!wrap_target_is_accused(reporter, accused));
    }

    #[test]
    fn reporter_meta_hides_claimer_except_awaiting_late_wrap() {
        let reporter = Uuid::from_u128(1);
        let claimer = Uuid::from_u128(2);
        let mut claimed = FrankingReportMetaDto {
            report_uuid: Uuid::nil(),
            persisted_message_uuid: Uuid::nil(),
            conversation_uuid: Uuid::nil(),
            category: FrankingReportCategory::Abuse,
            status: FrankingReportStatus::Claimed,
            claimed_by: Some(claimer),
            claimed_at: Some("2026-08-17T12:00:00.000Z".into()),
            created_at: "2026-08-17T12:00:00.000Z".into(),
            viewer_account_count: 1,
            has_disclosure: true,
            verification_status: FrankingVerificationStatus::Unverifiable,
            reporter_username: Some("reporter".into()),
            accused_username: Some("accused".into()),
        };
        hide_claimer_from_reporter(
            reporter,
            reporter,
            FrankingReportStatus::Claimed,
            &mut claimed,
        );
        assert!(claimed.claimed_by.is_none());
        assert!(claimed.claimed_at.is_none());
        assert_eq!(claimed.reporter_username.as_deref(), Some("reporter"));
        assert_eq!(claimed.accused_username.as_deref(), Some("accused"));

        let mut awaiting = claimed.clone();
        awaiting.status = FrankingReportStatus::ClaimedAwaitingDisclosure;
        awaiting.claimed_by = Some(claimer);
        awaiting.claimed_at = Some("2026-08-17T12:00:00.000Z".into());
        hide_claimer_from_reporter(
            reporter,
            reporter,
            FrankingReportStatus::ClaimedAwaitingDisclosure,
            &mut awaiting,
        );
        assert_eq!(awaiting.claimed_by, Some(claimer));

        let mut for_reviewer = awaiting.clone();
        hide_claimer_from_reporter(
            claimer,
            reporter,
            FrankingReportStatus::Claimed,
            &mut for_reviewer,
        );
        assert_eq!(for_reviewer.claimed_by, Some(claimer));
    }

    #[test]
    fn username_from_map_returns_known_and_skips_missing() {
        let mut map = HashMap::new();
        let reporter = Uuid::from_u128(1);
        map.insert(reporter, "alice".into());
        assert_eq!(username_from_map(&map, reporter).as_deref(), Some("alice"));
        assert!(username_from_map(&map, Uuid::from_u128(2)).is_none());
    }

    #[test]
    fn host_config_debug_redacts_signing_seed() {
        let cfg = crate::FrankingHostConfig {
            signing_seed: Some("super-secret-seed".into()),
            reviewer_user_uuids: vec!["11111111-1111-1111-1111-111111111111".into()],
        };
        let debug = format!("{cfg:?}");
        assert!(!debug.contains("super-secret-seed"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn queue_cursor_roundtrip_and_rejects_garbage() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-08-17T12:00:00.123456Z")
            .unwrap()
            .with_timezone(&Utc);
        let id = Uuid::from_u128(9);
        let enc = encode_queue_cursor(at, id);
        let (got_at, got_id) = decode_queue_cursor(Some(&enc)).unwrap().unwrap();
        assert_eq!(got_at, at);
        assert_eq!(got_id, id);
        let millis = at.to_rfc3339_opts(SecondsFormat::Millis, true);
        let truncated = chrono::DateTime::parse_from_rfc3339(&millis)
            .unwrap()
            .with_timezone(&Utc);
        assert!(at > truncated);
        assert!(decode_queue_cursor(None).unwrap().is_none());
        assert!(decode_queue_cursor(Some("")).unwrap().is_none());
        assert!(matches!(
            decode_queue_cursor(Some("%%%")),
            Err(FrankingError::BadRequest(_))
        ));
    }

    #[test]
    fn seed_parses_hex_and_b64u() {
        let hex = "aa".repeat(32);
        assert_eq!(parse_franking_seed(&hex).unwrap()[0], 0xaa);
        let raw = [7u8; 32];
        let b64 = URL_SAFE_NO_PAD.encode(raw);
        assert_eq!(parse_franking_seed(&b64).unwrap(), raw);
        assert!(parse_franking_seed("").is_none());
    }

    #[test]
    fn reviewer_uuid_list_parses_mixed_separators() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        let raw = format!("{a}, {b};");
        assert_eq!(parse_reviewer_uuids(&raw).unwrap(), vec![a, b]);
        assert!(parse_reviewer_uuids("").unwrap().is_empty());
        assert!(parse_reviewer_uuids("not-a-uuid").is_err());
        assert!(parse_reviewer_uuids(&format!("{a}, nope")).is_err());
    }

    #[test]
    fn signing_unavailable_http_body_has_stable_code() {
        let body = signing_unavailable_body();
        assert_eq!(body["code"], SIGNING_UNAVAILABLE_CODE);
        assert_eq!(body["code"], "messaging.franking.signing_unavailable");
        assert!(body["error"].as_str().is_some_and(|s| !s.is_empty()));
    }

    #[test]
    fn audit_events_roundtrip_db_tokens() {
        assert_eq!(
            parse_audit_event(audit_token(FrankingAuditEvent::Rejected)),
            Some(FrankingAuditEvent::Rejected)
        );
        assert_eq!(
            parse_audit_event(audit_token(FrankingAuditEvent::WrapCreated)),
            Some(FrankingAuditEvent::WrapCreated)
        );
    }

    #[test]
    fn wrap_write_errors_map_to_client_codes() {
        assert!(matches!(
            map_wrap_write_err("cap".into()),
            FrankingError::BadRequest(_)
        ));
        assert!(matches!(
            map_wrap_write_err("stale".into()),
            FrankingError::Conflict(_)
        ));
        assert!(matches!(
            map_wrap_write_err("empty_wrap".into()),
            FrankingError::BadRequest(_)
        ));
        assert!(matches!(
            map_wrap_write_err("closed".into()),
            FrankingError::Forbidden(_)
        ));
        assert!(matches!(
            map_wrap_write_err("party".into()),
            FrankingError::BadRequest(_)
        ));
        assert!(matches!(
            map_wrap_write_err("late_target".into()),
            FrankingError::BadRequest(_)
        ));
        assert!(matches!(
            map_wrap_write_err("db down".into()),
            FrankingError::Internal(_)
        ));
        assert!(matches!(
            map_report_write_err("quota".into()),
            FrankingError::TooManyRequests(_)
        ));
        assert!(matches!(
            map_report_write_err("party".into()),
            FrankingError::BadRequest(_)
        ));
        assert!(matches!(
            map_report_write_err("cap".into()),
            FrankingError::BadRequest(_)
        ));
        assert!(matches!(
            map_report_write_err("pk_franking_disclosure_wraps".into()),
            FrankingError::BadRequest(_)
        ));
        assert!(matches!(
            map_report_write_err("uq_franking_reports_live_reporter_message".into()),
            FrankingError::Conflict(_)
        ));
        assert!(matches!(
            map_report_write_err(
                "insert or update on table \"franking_reports\" violates foreign key constraint \"fk_franking_reports_message\""
                    .into()
            ),
            FrankingError::NotFound(_)
        ));
    }

    #[test]
    fn disclosure_errors_map_to_client_codes() {
        assert!(matches!(
            map_disclosure_err("missing".into()),
            FrankingError::NotFound(_)
        ));
        assert!(matches!(
            map_disclosure_err("closed".into()),
            FrankingError::Forbidden(_)
        ));
        assert!(matches!(
            map_disclosure_err("no_wrap".into()),
            FrankingError::Forbidden(_)
        ));
        assert!(matches!(
            map_disclosure_err("open".into()),
            FrankingError::Forbidden(_)
        ));
        assert!(matches!(
            map_disclosure_err("accused".into()),
            FrankingError::Forbidden(_)
        ));
    }

    #[test]
    fn late_wrap_on_claimed_locks_current_claimer() {
        let claimer = Uuid::from_u128(7);
        let reporter = Uuid::from_u128(8);
        let device = Uuid::from_u128(9);
        let for_claimer = vec![(claimer, device, vec![1])];
        let backup = vec![(reporter, device, vec![1])];
        assert_eq!(
            wrap_lock_for_late(FrankingReportStatus::Claimed, Some(claimer), &for_claimer),
            WrapLock::Claimer {
                claimer,
                promote: false
            }
        );
        assert_eq!(
            wrap_lock_for_late(
                FrankingReportStatus::ClaimedAwaitingDisclosure,
                Some(claimer),
                &for_claimer
            ),
            WrapLock::Claimer {
                claimer,
                promote: true
            }
        );
        assert_eq!(
            wrap_lock_for_late(FrankingReportStatus::Claimed, Some(claimer), &backup),
            WrapLock::Unlocked
        );
        assert_eq!(
            wrap_lock_for_late(FrankingReportStatus::Open, Some(claimer), &for_claimer),
            WrapLock::Unlocked
        );
    }

    #[test]
    fn empty_wrap_key_is_bad_request() {
        assert!(matches!(
            decode_wrap_key(""),
            Err(FrankingError::BadRequest(_))
        ));
    }

    #[test]
    fn receipt_dto_uses_signed_server_received_at() {
        let signed_at = "2026-01-01T00:00:00.123Z";
        let payload = format!(
            "{} | tag | {} | {} | {} | {} | {signed_at}",
            fscp_core::FSCP_FRANKING_RECEIPT_CONTEXT_V1,
            Uuid::nil(),
            Uuid::nil(),
            Uuid::nil(),
            Uuid::nil(),
        );
        let row = StoredFrankReceipt {
            message_uuid: Uuid::nil(),
            wire_message_uuid: Uuid::nil(),
            frank_tag: vec![0; 32],
            receipt_payload: payload,
            signature: vec![0; 64],
            key_id: Uuid::nil(),
            server_received_at: Utc::now(),
        };
        let (dto, _) = receipt_to_dto(&row);
        assert_eq!(dto.server_received_at, signed_at);
    }

    #[test]
    fn tagged_ingest_is_fail_closed_without_signer() {
        assert_eq!(tagged_ingest_action(false, false), TaggedIngest::Untagged);
        assert_eq!(tagged_ingest_action(false, true), TaggedIngest::Untagged);
        assert_eq!(tagged_ingest_action(true, true), TaggedIngest::Sign);
        assert_eq!(tagged_ingest_action(true, false), TaggedIngest::FailClosed);
    }

    fn plan_at_epoch(
        decision: FrankingResolveDecision,
        request: Option<AccountBlockRequest>,
    ) -> Result<Option<AccountBlockPlan>, FrankingError> {
        let now = chrono::DateTime::parse_from_rfc3339("2026-08-18T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        plan_account_block(decision, request.as_ref(), now)
    }

    #[test]
    fn rejected_never_bans_even_with_account_block() {
        assert_eq!(
            plan_at_epoch(
                FrankingResolveDecision::Rejected,
                Some(AccountBlockRequest { days: Some(7) })
            )
            .unwrap(),
            None
        );
        assert_eq!(
            plan_at_epoch(
                FrankingResolveDecision::Rejected,
                Some(AccountBlockRequest { days: None })
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn resolve_without_account_block_never_bans() {
        assert_eq!(
            plan_at_epoch(FrankingResolveDecision::Resolved, None).unwrap(),
            None
        );
    }

    #[test]
    fn missing_days_bans_forever_with_forever_code() {
        let plan = plan_at_epoch(
            FrankingResolveDecision::Resolved,
            Some(AccountBlockRequest { days: None }),
        )
        .unwrap()
        .expect("forever plan");
        assert_eq!(plan.blocked_until, None);
        assert_eq!(plan.resolution_code, "block-forever");
    }

    #[test]
    fn days_within_range_set_deadline_and_code() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-08-18T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        for days in [MIN_ACCOUNT_BLOCK_DAYS, 7, 365, MAX_ACCOUNT_BLOCK_DAYS] {
            let plan = plan_account_block(
                FrankingResolveDecision::Resolved,
                Some(&AccountBlockRequest { days: Some(days) }),
                now,
            )
            .unwrap()
            .expect("timed plan");
            assert_eq!(
                plan.blocked_until,
                Some(now + Duration::days(i64::from(days)))
            );
            assert_eq!(plan.resolution_code, format!("block-{days}d"));
        }
    }

    #[test]
    fn days_outside_range_is_bad_request() {
        for days in [0, MAX_ACCOUNT_BLOCK_DAYS + 1, u32::MAX] {
            assert!(matches!(
                plan_at_epoch(
                    FrankingResolveDecision::Resolved,
                    Some(AccountBlockRequest { days: Some(days) })
                ),
                Err(FrankingError::BadRequest(_))
            ));
        }
    }

    #[tokio::test]
    async fn block_targets_accused_and_is_authored_by_the_closing_reviewer() {
        use crate::application::test_ports::{RecordingSanctions, StubAccounts, lazy_pool};

        let sanctions = Arc::new(RecordingSanctions::default());
        let service = FrankingService::new(
            Arc::new(FrankingRepo::new(lazy_pool())),
            None,
            Arc::new(StubAccounts),
            sanctions.clone(),
        );
        let reporter = Uuid::from_u128(1);
        let accused = Uuid::from_u128(2);
        let reviewer = Uuid::from_u128(3);
        let deadline = chrono::DateTime::parse_from_rfc3339("2026-08-25T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let row = ReportRow {
            report_uuid: Uuid::from_u128(4),
            persisted_message_uuid: Uuid::from_u128(5),
            wire_message_uuid: Uuid::from_u128(5),
            conversation_uuid: Uuid::from_u128(6),
            reporter_user_uuid: reporter,
            accused_user_uuid: accused,
            category: "abuse".into(),
            status: "claimed".into(),
            claimed_by: Some(reviewer),
            claimed_at: None,
            has_disclosure: true,
            created_at: deadline,
        };

        service
            .apply_account_block(
                &row,
                reviewer,
                &AccountBlockPlan {
                    blocked_until: Some(deadline),
                    resolution_code: "block-7d".into(),
                },
            )
            .await
            .expect("apply block");

        assert_eq!(
            sanctions.calls(),
            vec![(accused, Some(deadline), reviewer)],
            "бан кладётся на accused, автор — закрывающий ревьюер"
        );
    }

    #[test]
    fn server_key_without_signer_serializes_explicit_nulls() {
        let json = serde_json::to_value(FrankingServerKeyDto {
            server_franking_key_id: None,
            public_key_base64_url: None,
        })
        .expect("json");
        assert!(json["serverFrankingKeyId"].is_null());
        assert!(json["publicKeyBase64Url"].is_null());
    }
}
