//! Хранение квитанций franking и exclusive-claim заявок.

use std::collections::{HashMap, HashSet};
use std::fmt;

use chrono::{DateTime, Utc};
use flora_messaging_contracts::FrankingWrapTargetDto;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WrapLock {
    Unlocked,
    /// Late viewer-wrap на текущего claimerа. `promote` — awaiting → claimed.
    Claimer {
        claimer: Uuid,
        promote: bool,
    },
    ForwardCap {
        reporter: Uuid,
        claimer: Uuid,
        max: i64,
    },
}

#[derive(Clone, sqlx::FromRow)]
pub struct StoredFrankReceipt {
    pub message_uuid: Uuid,
    pub wire_message_uuid: Uuid,
    pub frank_tag: Vec<u8>,
    pub receipt_payload: String,
    pub signature: Vec<u8>,
    pub key_id: Uuid,
    pub server_received_at: DateTime<Utc>,
}

impl fmt::Debug for StoredFrankReceipt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredFrankReceipt")
            .field("message_uuid", &self.message_uuid)
            .field("wire_message_uuid", &self.wire_message_uuid)
            .field("frank_tag", &"<redacted>")
            .field("receipt_payload_len", &self.receipt_payload.len())
            .field("signature", &"<redacted>")
            .field("key_id", &self.key_id)
            .field("server_received_at", &self.server_received_at)
            .finish()
    }
}

#[derive(Clone)]
pub struct InsertFrankReceipt {
    pub message_uuid: Uuid,
    pub wire_message_uuid: Uuid,
    pub frank_tag: [u8; 32],
    pub receipt_payload: String,
    pub signature: [u8; 64],
    pub key_id: Uuid,
    pub server_received_at: DateTime<Utc>,
}

impl fmt::Debug for InsertFrankReceipt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InsertFrankReceipt")
            .field("message_uuid", &self.message_uuid)
            .field("wire_message_uuid", &self.wire_message_uuid)
            .field("frank_tag", &"<redacted>")
            .field("receipt_payload_len", &self.receipt_payload.len())
            .field("signature", &"<redacted>")
            .field("key_id", &self.key_id)
            .field("server_received_at", &self.server_received_at)
            .finish()
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MessageParticipantsRow {
    pub message_uuid: Uuid,
    pub sender_user_uuid: Uuid,
    pub receiver_user_uuid: Uuid,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ReportRow {
    pub report_uuid: Uuid,
    pub persisted_message_uuid: Uuid,
    pub wire_message_uuid: Uuid,
    pub conversation_uuid: Uuid,
    pub reporter_user_uuid: Uuid,
    pub accused_user_uuid: Uuid,
    pub category: String,
    pub status: String,
    pub claimed_by: Option<Uuid>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub has_disclosure: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, sqlx::FromRow)]
pub struct WrapRow {
    pub user_uuid: Uuid,
    pub device_uuid: Uuid,
    pub wrapped_key: Vec<u8>,
}

impl fmt::Debug for WrapRow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WrapRow")
            .field("user_uuid", &self.user_uuid)
            .field("device_uuid", &self.device_uuid)
            .field("wrapped_key", &"<redacted>")
            .finish()
    }
}

#[derive(Clone)]
pub struct FetchedDisclosure {
    pub persisted_message_uuid: Uuid,
    pub ciphertext: Vec<u8>,
    pub wraps: Vec<WrapRow>,
    pub receipt: Option<StoredFrankReceipt>,
}

impl fmt::Debug for FetchedDisclosure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FetchedDisclosure")
            .field("persisted_message_uuid", &self.persisted_message_uuid)
            .field("ciphertext_len", &self.ciphertext.len())
            .field("wraps", &self.wraps)
            .field("receipt", &self.receipt)
            .finish()
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuditRow {
    pub audit_uuid: Uuid,
    pub event: String,
    pub actor_user_uuid: Uuid,
    pub subject_user_uuid: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

pub struct FrankingRepo {
    pool: PgPool,
}

#[derive(sqlx::FromRow)]
struct WrapTargetRow {
    user_uuid: Uuid,
    device_uuid: Uuid,
    agreement_public_key_base64url: String,
}

fn wrap_targets_from_rows(rows: Vec<WrapTargetRow>) -> Vec<FrankingWrapTargetDto> {
    rows.into_iter()
        .map(|r| FrankingWrapTargetDto {
            user_uuid: r.user_uuid,
            device_uuid: r.device_uuid,
            agreement_public_key_base64_url: r.agreement_public_key_base64url,
        })
        .collect()
}

impl FrankingRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn upsert_reviewers(&self, user_uuids: &[Uuid]) -> Result<(), String> {
        if user_uuids.is_empty() {
            return Ok(());
        }
        let now = Utc::now();
        for user_uuid in user_uuids {
            sqlx::query(
                r#"
                INSERT INTO flora_core.franking_reviewers (user_uuid, added_at, revoked_at)
                VALUES ($1, $2, NULL)
                ON CONFLICT (user_uuid) DO UPDATE SET revoked_at = NULL
                "#,
            )
            .bind(user_uuid)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub async fn is_active_reviewer(&self, user_uuid: Uuid) -> Result<bool, String> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM flora_core.franking_reviewers
                WHERE user_uuid = $1 AND revoked_at IS NULL
            )
            "#,
        )
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn active_reviewer_uuids(&self) -> Result<Vec<Uuid>, String> {
        sqlx::query_scalar(
            r#"
            SELECT user_uuid FROM flora_core.franking_reviewers
            WHERE revoked_at IS NULL
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn active_reviewer_wrap_targets(
        &self,
        exclude_user: Uuid,
    ) -> Result<Vec<FrankingWrapTargetDto>, String> {
        let rows: Vec<WrapTargetRow> = sqlx::query_as(
            r#"
            SELECT udk.user_uuid, udk.device_uuid, udk.agreement_public_key_base64url
            FROM flora_core.user_device_keys udk
            INNER JOIN flora_core.franking_reviewers fr
                ON fr.user_uuid = udk.user_uuid AND fr.revoked_at IS NULL
            WHERE udk.status = 'Active'
              AND udk.user_uuid <> $1
            ORDER BY udk.user_uuid, udk.created_at
            "#,
        )
        .bind(exclude_user)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(wrap_targets_from_rows(rows))
    }

    pub async fn active_own_wrap_targets(
        &self,
        user_uuid: Uuid,
    ) -> Result<Vec<FrankingWrapTargetDto>, String> {
        let rows: Vec<WrapTargetRow> = sqlx::query_as(
            r#"
            SELECT user_uuid, device_uuid, agreement_public_key_base64url
            FROM flora_core.user_device_keys
            WHERE user_uuid = $1 AND status = 'Active'
            ORDER BY created_at
            "#,
        )
        .bind(user_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(wrap_targets_from_rows(rows))
    }

    pub async fn has_active_device(
        &self,
        user_uuid: Uuid,
        device_uuid: Uuid,
    ) -> Result<bool, String> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM flora_core.user_device_keys
                WHERE user_uuid = $1 AND device_uuid = $2 AND status = 'Active'
            )
            "#,
        )
        .bind(user_uuid)
        .bind(device_uuid)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn receipts_by_message_uuids(
        &self,
        ids: &[Uuid],
    ) -> Result<Vec<StoredFrankReceipt>, String> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(
            r#"
            SELECT message_uuid, wire_message_uuid, frank_tag, receipt_payload,
                   signature, key_id, server_received_at
            FROM flora_core.user_message_frank_receipts
            WHERE message_uuid = ANY($1)
            "#,
        )
        .bind(ids)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn receipt_for_message(
        &self,
        message_uuid: Uuid,
    ) -> Result<Option<StoredFrankReceipt>, String> {
        Ok(self
            .receipts_by_message_uuids(&[message_uuid])
            .await?
            .into_iter()
            .next())
    }

    pub async fn message_participants(
        &self,
        message_uuid: Uuid,
    ) -> Result<Option<MessageParticipantsRow>, String> {
        sqlx::query_as(
            r#"
            SELECT message_uuid, sender_user_uuid, receiver_user_uuid
            FROM flora_core.user_messages
            WHERE message_uuid = $1
            "#,
        )
        .bind(message_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn extract_wire_message_uuid(
        &self,
        persisted_message_uuid: Uuid,
        viewer_uuid: Uuid,
    ) -> Result<Option<String>, String> {
        sqlx::query_as::<_, (Option<String>, Option<String>, Uuid)>(
            r#"
            SELECT encrypted_for_receiver, encrypted_for_sender, sender_user_uuid
            FROM flora_core.user_messages
            WHERE message_uuid = $1
              AND (sender_user_uuid = $2 OR receiver_user_uuid = $2)
            "#,
        )
        .bind(persisted_message_uuid)
        .bind(viewer_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())
        .map(|row| {
            row.and_then(
                |(enc_r, enc_s, sender)| {
                    if sender == viewer_uuid { enc_s } else { enc_r }
                },
            )
        })
    }

    pub async fn reports_created_since(
        &self,
        reporter: Uuid,
        since: DateTime<Utc>,
    ) -> Result<i64, String> {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint FROM flora_core.franking_reports
            WHERE reporter_user_uuid = $1 AND created_at >= $2
            "#,
        )
        .bind(reporter)
        .bind(since)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn insert_report(
        &self,
        row: &ReportRow,
        disclosure_ciphertext: &[u8],
        wraps: &[(Uuid, Uuid, Vec<u8>)],
        audit: &[(String, Uuid, Option<Uuid>)],
        max_per_day: i64,
        max_viewers: i64,
    ) -> Result<(), String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        sqlx::query(
            r#"
            SELECT pg_advisory_xact_lock(hashtext('flora.franking.quota'), hashtext($1::text))
            "#,
        )
        .bind(row.reporter_user_uuid)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let recent: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::bigint FROM flora_core.franking_reports
            WHERE reporter_user_uuid = $1 AND created_at >= $2
            "#,
        )
        .bind(row.reporter_user_uuid)
        .bind(row.created_at - chrono::Duration::hours(24))
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if recent >= max_per_day {
            return Err("quota".into());
        }
        let mut viewers = HashSet::new();
        for (user_uuid, _, _) in wraps {
            if *user_uuid != row.reporter_user_uuid {
                viewers.insert(*user_uuid);
            }
        }
        if viewers.len() as i64 > max_viewers {
            return Err("cap".into());
        }
        sqlx::query(
            r#"
            INSERT INTO flora_core.franking_reports (
                report_uuid, persisted_message_uuid, wire_message_uuid, conversation_uuid,
                reporter_user_uuid, accused_user_uuid, category, status,
                claimed_by, claimed_at, disclosure_ciphertext, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            "#,
        )
        .bind(row.report_uuid)
        .bind(row.persisted_message_uuid)
        .bind(row.wire_message_uuid)
        .bind(row.conversation_uuid)
        .bind(row.reporter_user_uuid)
        .bind(row.accused_user_uuid)
        .bind(&row.category)
        .bind(&row.status)
        .bind(row.claimed_by)
        .bind(row.claimed_at)
        .bind(disclosure_ciphertext)
        .bind(row.created_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        for (user_uuid, device_uuid, wrapped_key) in wraps {
            if *user_uuid == row.accused_user_uuid {
                return Err("party".into());
            }
            if wrapped_key.is_empty() {
                return Err("empty_wrap".into());
            }
            sqlx::query(
                r#"
                INSERT INTO flora_core.franking_disclosure_wraps
                    (report_uuid, user_uuid, device_uuid, wrapped_key, created_at)
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(row.report_uuid)
            .bind(user_uuid)
            .bind(device_uuid)
            .bind(wrapped_key)
            .bind(row.created_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }

        for (event, actor, subject) in audit {
            insert_audit_tx(
                &mut tx,
                row.report_uuid,
                event,
                *actor,
                *subject,
                row.created_at,
            )
            .await?;
        }

        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn get_report(&self, report_uuid: Uuid) -> Result<Option<ReportRow>, String> {
        sqlx::query_as(
            r#"
            SELECT report_uuid, persisted_message_uuid, wire_message_uuid, conversation_uuid,
                   reporter_user_uuid, accused_user_uuid, category, status,
                   claimed_by, claimed_at, created_at,
                   (octet_length(disclosure_ciphertext) > 0) AS has_disclosure
            FROM flora_core.franking_reports
            WHERE report_uuid = $1
            "#,
        )
        .bind(report_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn list_queue(
        &self,
        limit: i64,
        viewer: Uuid,
        after: Option<(DateTime<Utc>, Uuid)>,
    ) -> Result<Vec<ReportRow>, String> {
        match after {
            Some((created_at, report_uuid)) => sqlx::query_as(
                r#"
                SELECT report_uuid, persisted_message_uuid, wire_message_uuid, conversation_uuid,
                       reporter_user_uuid, accused_user_uuid, category, status,
                       claimed_by, claimed_at, created_at,
                       (octet_length(disclosure_ciphertext) > 0) AS has_disclosure
                FROM flora_core.franking_reports
                WHERE status IN ('open', 'claimed', 'claimed_awaiting_disclosure')
                  AND accused_user_uuid <> $4
                  AND (created_at, report_uuid) > ($2, $3)
                ORDER BY created_at ASC, report_uuid ASC
                LIMIT $1
                "#,
            )
            .bind(limit)
            .bind(created_at)
            .bind(report_uuid)
            .bind(viewer)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string()),
            None => sqlx::query_as(
                r#"
                SELECT report_uuid, persisted_message_uuid, wire_message_uuid, conversation_uuid,
                       reporter_user_uuid, accused_user_uuid, category, status,
                       claimed_by, claimed_at, created_at,
                       (octet_length(disclosure_ciphertext) > 0) AS has_disclosure
                FROM flora_core.franking_reports
                WHERE status IN ('open', 'claimed', 'claimed_awaiting_disclosure')
                  AND accused_user_uuid <> $2
                ORDER BY created_at ASC, report_uuid ASC
                LIMIT $1
                "#,
            )
            .bind(limit)
            .bind(viewer)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| e.to_string()),
        }
    }

    pub async fn viewer_account_count(
        &self,
        report_uuid: Uuid,
        reporter: Uuid,
    ) -> Result<i64, String> {
        sqlx::query_scalar(
            r#"
            SELECT COUNT(DISTINCT user_uuid)::bigint
            FROM flora_core.franking_disclosure_wraps
            WHERE report_uuid = $1
              AND user_uuid <> $2
              AND user_uuid <> (
                  SELECT accused_user_uuid FROM flora_core.franking_reports
                  WHERE report_uuid = $1
              )
            "#,
        )
        .bind(report_uuid)
        .bind(reporter)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn viewer_counts_for_reports(
        &self,
        report_uuids: &[Uuid],
    ) -> Result<HashMap<Uuid, i64>, String> {
        if report_uuids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(Uuid, i64)> = sqlx::query_as(
            r#"
            SELECT w.report_uuid, COUNT(DISTINCT w.user_uuid)::bigint
            FROM flora_core.franking_disclosure_wraps w
            JOIN flora_core.franking_reports r ON r.report_uuid = w.report_uuid
            WHERE w.report_uuid = ANY($1)
              AND w.user_uuid <> r.reporter_user_uuid
              AND w.user_uuid <> r.accused_user_uuid
            GROUP BY w.report_uuid
            "#,
        )
        .bind(report_uuids)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows.into_iter().collect())
    }

    pub async fn has_viewer_wrap(
        &self,
        report_uuid: Uuid,
        user_uuid: Uuid,
    ) -> Result<bool, String> {
        sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM flora_core.franking_disclosure_wraps
                WHERE report_uuid = $1 AND user_uuid = $2
            )
            "#,
        )
        .bind(report_uuid)
        .bind(user_uuid)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    pub async fn fetch_disclosure(
        &self,
        report_uuid: Uuid,
        caller: Uuid,
        now: DateTime<Utc>,
    ) -> Result<FetchedDisclosure, String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let locked: Option<(String, Uuid, Uuid, Uuid, Vec<u8>)> = sqlx::query_as(
            r#"
            SELECT status, reporter_user_uuid, accused_user_uuid, persisted_message_uuid,
                   disclosure_ciphertext
            FROM flora_core.franking_reports
            WHERE report_uuid = $1
            FOR UPDATE
            "#,
        )
        .bind(report_uuid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let Some((status, reporter, accused, persisted_message_uuid, ciphertext)) = locked else {
            return Err("missing".into());
        };
        if caller == reporter || caller == accused {
            return Err(if caller == reporter {
                "reporter"
            } else {
                "accused"
            }
            .into());
        }
        match status.as_str() {
            "claimed" | "claimed_awaiting_disclosure" => {}
            "resolved" | "rejected" => return Err("closed".into()),
            "open" => return Err("open".into()),
            _ => return Err("stale".into()),
        }
        let wraps: Vec<WrapRow> = sqlx::query_as(
            r#"
            SELECT user_uuid, device_uuid, wrapped_key
            FROM flora_core.franking_disclosure_wraps
            WHERE report_uuid = $1 AND user_uuid = $2
            FOR UPDATE
            "#,
        )
        .bind(report_uuid)
        .bind(caller)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if wraps.is_empty() {
            return Err("no_wrap".into());
        }
        let receipt: Option<StoredFrankReceipt> = sqlx::query_as(
            r#"
            SELECT message_uuid, wire_message_uuid, frank_tag, receipt_payload,
                   signature, key_id, server_received_at
            FROM flora_core.user_message_frank_receipts
            WHERE message_uuid = $1
            "#,
        )
        .bind(persisted_message_uuid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        insert_audit_tx(
            &mut tx,
            report_uuid,
            "disclosure_fetched",
            caller,
            Some(caller),
            now,
        )
        .await?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(FetchedDisclosure {
            persisted_message_uuid,
            ciphertext,
            wraps,
            receipt,
        })
    }

    pub async fn claim_open(
        &self,
        report_uuid: Uuid,
        claimer: Uuid,
        reporter: Uuid,
        now: DateTime<Utc>,
    ) -> Result<bool, String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let updated = sqlx::query(
            r#"
            UPDATE flora_core.franking_reports
            SET status = CASE
                    WHEN EXISTS(
                        SELECT 1 FROM flora_core.franking_disclosure_wraps
                        WHERE report_uuid = $1 AND user_uuid = $2
                    ) THEN 'claimed'
                    ELSE 'claimed_awaiting_disclosure'
                END,
                claimed_by = $2,
                claimed_at = $3
            WHERE report_uuid = $1
              AND status = 'open'
              AND reporter_user_uuid <> $2
              AND accused_user_uuid <> $2
            "#,
        )
        .bind(report_uuid)
        .bind(claimer)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            tx.rollback().await.ok();
            return Ok(false);
        }

        let destroyed: Vec<Uuid> = sqlx::query_scalar(
            r#"
            DELETE FROM flora_core.franking_disclosure_wraps
            WHERE report_uuid = $1
              AND user_uuid <> $2
              AND user_uuid <> $3
            RETURNING user_uuid
            "#,
        )
        .bind(report_uuid)
        .bind(reporter)
        .bind(claimer)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        insert_audit_tx(&mut tx, report_uuid, "claimed", claimer, Some(claimer), now).await?;
        for subject in destroyed {
            insert_audit_tx(
                &mut tx,
                report_uuid,
                "wrap_destroyed",
                claimer,
                Some(subject),
                now,
            )
            .await?;
        }

        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub async fn insert_wraps(
        &self,
        report_uuid: Uuid,
        wraps: &[(Uuid, Uuid, Vec<u8>)],
        actor: Uuid,
        event: &str,
        now: DateTime<Utc>,
        lock: WrapLock,
    ) -> Result<(), String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let (status, claimed_by, reporter, accused) = lock_report_row(&mut tx, report_uuid).await?;
        if status == "resolved" || status == "rejected" {
            return Err("closed".into());
        }
        for (user_uuid, _, _) in wraps {
            if *user_uuid == accused {
                return Err("party".into());
            }
        }
        match lock {
            WrapLock::Unlocked => {
                for (user_uuid, _, _) in wraps {
                    if *user_uuid != reporter {
                        return Err("late_target".into());
                    }
                }
            }
            WrapLock::Claimer { claimer, promote } => {
                if claimed_by != Some(claimer) {
                    return Err("stale".into());
                }
                let expected = if promote {
                    "claimed_awaiting_disclosure"
                } else {
                    "claimed"
                };
                if status != expected {
                    return Err("stale".into());
                }
                for (user_uuid, _, _) in wraps {
                    if *user_uuid != reporter && *user_uuid != claimer {
                        return Err("late_target".into());
                    }
                }
            }
            WrapLock::ForwardCap {
                reporter,
                claimer,
                max,
            } => {
                if status != "claimed" || claimed_by != Some(claimer) {
                    return Err("stale".into());
                }
                let current: i64 = sqlx::query_scalar(
                    r#"
                    SELECT COUNT(DISTINCT user_uuid)::bigint
                    FROM flora_core.franking_disclosure_wraps
                    WHERE report_uuid = $1 AND user_uuid <> $2
                    "#,
                )
                .bind(report_uuid)
                .bind(reporter)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                let mut new_users = HashSet::new();
                for (user_uuid, _, _) in wraps {
                    if *user_uuid == reporter {
                        continue;
                    }
                    let already: bool = sqlx::query_scalar(
                        r#"
                        SELECT EXISTS(
                            SELECT 1 FROM flora_core.franking_disclosure_wraps
                            WHERE report_uuid = $1 AND user_uuid = $2
                        )
                        "#,
                    )
                    .bind(report_uuid)
                    .bind(user_uuid)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    if !already {
                        new_users.insert(*user_uuid);
                    }
                }
                if current + new_users.len() as i64 > max {
                    return Err("cap".into());
                }
            }
        }
        for (user_uuid, device_uuid, wrapped_key) in wraps {
            if wrapped_key.is_empty() {
                return Err("empty_wrap".into());
            }
            sqlx::query(
                r#"
                INSERT INTO flora_core.franking_disclosure_wraps
                    (report_uuid, user_uuid, device_uuid, wrapped_key, created_at)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (report_uuid, user_uuid, device_uuid) DO UPDATE
                    SET wrapped_key = EXCLUDED.wrapped_key
                "#,
            )
            .bind(report_uuid)
            .bind(user_uuid)
            .bind(device_uuid)
            .bind(wrapped_key)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            insert_audit_tx(&mut tx, report_uuid, event, actor, Some(*user_uuid), now).await?;
        }
        if let WrapLock::Claimer {
            claimer,
            promote: true,
        } = lock
        {
            let updated = sqlx::query(
                r#"
                UPDATE flora_core.franking_reports
                SET status = 'claimed'
                WHERE report_uuid = $1
                  AND claimed_by = $2
                  AND status = 'claimed_awaiting_disclosure'
                "#,
            )
            .bind(report_uuid)
            .bind(claimer)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if updated.rows_affected() != 1 {
                return Err("stale".into());
            }
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn release(
        &self,
        report_uuid: Uuid,
        claimer: Uuid,
        reporter: Uuid,
        now: DateTime<Utc>,
    ) -> Result<bool, String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let updated = sqlx::query(
            r#"
            UPDATE flora_core.franking_reports
            SET status = 'open', claimed_by = NULL, claimed_at = NULL
            WHERE report_uuid = $1
              AND claimed_by = $2
              AND status IN ('claimed', 'claimed_awaiting_disclosure')
            "#,
        )
        .bind(report_uuid)
        .bind(claimer)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            tx.rollback().await.ok();
            return Ok(false);
        }

        let destroyed: Vec<Uuid> = sqlx::query_scalar(
            r#"
            DELETE FROM flora_core.franking_disclosure_wraps
            WHERE report_uuid = $1 AND user_uuid <> $2
            RETURNING user_uuid
            "#,
        )
        .bind(report_uuid)
        .bind(reporter)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        insert_audit_tx(
            &mut tx,
            report_uuid,
            "released",
            claimer,
            Some(claimer),
            now,
        )
        .await?;
        for subject in destroyed {
            insert_audit_tx(
                &mut tx,
                report_uuid,
                "wrap_destroyed",
                claimer,
                Some(subject),
                now,
            )
            .await?;
        }

        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub async fn resolve(
        &self,
        report_uuid: Uuid,
        claimer: Uuid,
        status: &str,
        code: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<bool, String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let updated = sqlx::query(
            r#"
            UPDATE flora_core.franking_reports
            SET status = $3, resolution_code = $4
            WHERE report_uuid = $1 AND claimed_by = $2
              AND status IN ('claimed', 'claimed_awaiting_disclosure')
            "#,
        )
        .bind(report_uuid)
        .bind(claimer)
        .bind(status)
        .bind(code)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            tx.rollback().await.ok();
            return Ok(false);
        }
        insert_audit_tx(&mut tx, report_uuid, status, claimer, None, now).await?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub async fn list_audit(&self, report_uuid: Uuid) -> Result<Vec<AuditRow>, String> {
        sqlx::query_as(
            r#"
            SELECT audit_uuid, event, actor_user_uuid, subject_user_uuid, created_at
            FROM flora_core.franking_report_audit
            WHERE report_uuid = $1
            ORDER BY created_at ASC
            "#,
        )
        .bind(report_uuid)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }
}

async fn lock_report_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    report_uuid: Uuid,
) -> Result<(String, Option<Uuid>, Uuid, Uuid), String> {
    sqlx::query_as(
        r#"
        SELECT status, claimed_by, reporter_user_uuid, accused_user_uuid
        FROM flora_core.franking_reports
        WHERE report_uuid = $1
        FOR UPDATE
        "#,
    )
    .bind(report_uuid)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "stale".into())
}

async fn insert_audit_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    report_uuid: Uuid,
    event: &str,
    actor: Uuid,
    subject: Option<Uuid>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO flora_core.franking_report_audit
            (audit_uuid, report_uuid, event, actor_user_uuid, subject_user_uuid, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(Uuid::now_v7())
    .bind(report_uuid)
    .bind(event)
    .bind(actor)
    .bind(subject)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
