//! PostgreSQL integration: exclusive-claim очередь и fail-closed tagged ingest.
//!
//! ```powershell
//! $env:FLORA_FRANKING_PG = "1"
//! cargo test -p flora-messaging --test franking_reports_pg -- --nocapture --test-threads=1
//! ```
//! Без `FLORA_FRANKING_PG=1` тесты no-op (skip).

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::Utc;
use ed25519_dalek::{Signer, SigningKey};
use flora_auth_contracts::{AccountDirectory, AccountPublicInfo, BoxFuture as AuthBoxFuture};
use flora_messaging::application::{
    ConversationService, FrankingError, FrankingService, FrankingSigner, SendMessageError,
    signing_unavailable_body,
};
use flora_messaging::infrastructure::{FrankingRepo, InsertFrankReceipt, MessagingRepo};
use flora_messaging_contracts::{
    CreateFrankingReportRequest, DeleteMessageOutcome, ForwardFrankingReportRequest,
    FrankingAuditEvent, FrankingDisclosureWrapDto, FrankingReportCategory, FrankingReportStatus,
    FrankingResolveDecision, FrankingVerificationStatus, NoopMessageReadNotifier,
    NoopMessageSentNotifier, NoopMessageTypingNotifier, NoopPushPreviewTargetProvider,
    PostConversationMessageRequest, PostFrankingWrapsRequest, ResolveFrankingReportRequest,
};
use flora_shared::config::FloraConfig;
use flora_shared::npgsql::NpgsqlConnectionString;
use flora_shared::uuid_v5::dm_conversation_uuid;
use flora_users_contracts::{
    BoxFuture as UsersBoxFuture, FeedAuthorProfile, FeedAuthorProfiles, LastSeenRow,
    MessagesAccess, OnlineStatusAccess, UserPresence,
};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

fn enabled() -> bool {
    std::env::var("FLORA_FRANKING_PG").ok().as_deref() == Some("1")
}

async fn connect() -> PgPool {
    let raw = if let Ok(url) = std::env::var("FLORA_FRANKING_PG_URL") {
        url
    } else {
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for _ in 0..5 {
            path.pop();
        }
        path.push("Backend");
        let cfg = FloraConfig::load("Development", &path).expect("Backend/appsettings");
        cfg.get_non_empty("ConnectionStrings:FloraDatabase")
            .expect("ConnectionStrings:FloraDatabase")
            .to_string()
    };
    let parsed = NpgsqlConnectionString::parse(&raw).expect("npgsql");
    let mut options = PgConnectOptions::new()
        .host(parsed.host.as_deref().unwrap_or("localhost"))
        .port(parsed.port.unwrap_or(5432));
    if let Some(database) = &parsed.database {
        options = options.database(database);
    }
    if let Some(username) = &parsed.username {
        options = options.username(username);
    }
    if let Some(password) = &parsed.password {
        options = options.password(password);
    }
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .expect("pg");
    require_franking_schema(&pool).await;
    pool
}

async fn require_franking_schema(pool: &PgPool) {
    let present: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('flora_core.franking_reports')::text")
            .fetch_one(pool)
            .await
            .expect("to_regclass flora_core.franking_reports");
    assert!(
        present.is_some(),
        "flora_core.franking_reports отсутствует — примените flora-migrate (DoD migrate-up). Не вызывайте flora_messaging::MIGRATOR.run(): история модуля — __flora_migrations_messaging, не _sqlx_migrations."
    );
}

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn wrap(user: Uuid, device: Uuid) -> FrankingDisclosureWrapDto {
    FrankingDisclosureWrapDto {
        user_uuid: user,
        device_uuid: device,
        wrapped_key: b64(&[3u8; 32]),
    }
}

async fn insert_message(pool: &PgPool, sender: Uuid, receiver: Uuid) -> Uuid {
    let message_uuid = Uuid::now_v7();
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_messages
            (message_uuid, sender_user_uuid, receiver_user_uuid, content,
             encrypted_for_receiver, encrypted_for_sender, created_at, is_read)
        VALUES ($1, $2, $3, NULL, $4, $4, $5, false)
        "#,
    )
    .bind(message_uuid)
    .bind(sender)
    .bind(receiver)
    .bind(format!("fscp1:test-{message_uuid}"))
    .bind(Utc::now())
    .execute(pool)
    .await
    .expect("insert message");
    message_uuid
}

async fn insert_device(pool: &PgPool, user: Uuid) -> Uuid {
    let device_uuid = Uuid::now_v7();
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_device_keys
            (device_uuid, user_uuid, key_epoch_id, display_name,
             signing_public_key_base64url, agreement_public_key_base64url,
             status, created_at)
        VALUES ($1, $2, $3, 'franking-test', $4, $4, 'Active', $5)
        "#,
    )
    .bind(device_uuid)
    .bind(user)
    .bind(uuid::uuid!("00000000-0000-4000-8000-000000000001"))
    .bind(b64(&[9u8; 32]))
    .bind(Utc::now())
    .execute(pool)
    .await
    .expect("insert device");
    device_uuid
}

async fn cleanup(pool: &PgPool, messages: &[Uuid], reviewers: &[Uuid], devices: &[Uuid]) {
    if !messages.is_empty() {
        let _ = sqlx::query(
            "DELETE FROM flora_core.franking_reports WHERE persisted_message_uuid = ANY($1)",
        )
        .bind(messages)
        .execute(pool)
        .await;
        let _ = sqlx::query("DELETE FROM flora_core.user_messages WHERE message_uuid = ANY($1)")
            .bind(messages)
            .execute(pool)
            .await;
    }
    if !reviewers.is_empty() {
        let _ = sqlx::query("DELETE FROM flora_core.franking_reviewers WHERE user_uuid = ANY($1)")
            .bind(reviewers)
            .execute(pool)
            .await;
    }
    if !devices.is_empty() {
        let _ = sqlx::query("DELETE FROM flora_core.user_device_keys WHERE device_uuid = ANY($1)")
            .bind(devices)
            .execute(pool)
            .await;
    }
}

fn franking(pool: &PgPool, seed: Option<[u8; 32]>) -> FrankingService {
    FrankingService::new(
        Arc::new(FrankingRepo::new(pool.clone())),
        seed.map(|s| Arc::new(FrankingSigner::from_seed(s))),
    )
}

struct AllowAll;

impl AccountDirectory for AllowAll {
    fn get_public(
        &self,
        user_uuid: Uuid,
    ) -> AuthBoxFuture<'_, Result<Option<AccountPublicInfo>, String>> {
        Box::pin(async move {
            Ok(Some(AccountPublicInfo {
                user_uuid,
                username: "u".into(),
                phone: String::new(),
                email: String::new(),
            }))
        })
    }
    fn find_uuid_by_username(&self, _: &str) -> AuthBoxFuture<'_, Result<Option<Uuid>, String>> {
        Box::pin(async { Ok(None) })
    }
    fn usernames_by_uuids(
        &self,
        _: &[Uuid],
    ) -> AuthBoxFuture<'_, Result<Vec<(Uuid, String)>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn update_username(&self, _: Uuid, _: &str) -> AuthBoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn username_taken_by_other(&self, _: &str, _: Uuid) -> AuthBoxFuture<'_, Result<bool, String>> {
        Box::pin(async { Ok(false) })
    }
    fn is_username_reserved(&self, _: &str) -> bool {
        false
    }
    fn search_accounts_by_username_contains(
        &self,
        _: Uuid,
        _: &str,
    ) -> AuthBoxFuture<'_, Result<Vec<(Uuid, String)>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn list_active_user_uuids(&self) -> AuthBoxFuture<'_, Result<Vec<Uuid>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

impl FeedAuthorProfiles for AllowAll {
    fn by_uuids(&self, _: &[Uuid]) -> UsersBoxFuture<'_, Result<Vec<FeedAuthorProfile>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

impl UserPresence for AllowAll {
    fn touch(&self, _: Uuid) -> UsersBoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn last_seen_by_uuids(
        &self,
        _: &[Uuid],
    ) -> UsersBoxFuture<'_, Result<Vec<LastSeenRow>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn is_online_by_uuids(
        &self,
        _: &[Uuid],
    ) -> UsersBoxFuture<'_, Result<Vec<(Uuid, bool)>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

impl OnlineStatusAccess for AllowAll {
    fn can_see_online(&self, _: Uuid, _: Uuid) -> UsersBoxFuture<'_, Result<bool, String>> {
        Box::pin(async { Ok(false) })
    }
}

impl MessagesAccess for AllowAll {
    fn can_send_messages(&self, _: Uuid, _: Uuid) -> UsersBoxFuture<'_, Result<bool, String>> {
        Box::pin(async { Ok(true) })
    }
}

fn conversations(pool: PgPool, franking: Arc<FrankingService>) -> ConversationService {
    let allow = Arc::new(AllowAll);
    ConversationService::new(
        Arc::new(MessagingRepo::new(pool)),
        allow.clone(),
        allow.clone(),
        allow.clone(),
        allow.clone(),
        allow,
        Arc::new(NoopMessageSentNotifier),
        Arc::new(NoopMessageTypingNotifier),
        Arc::new(NoopMessageReadNotifier),
        Arc::new(NoopPushPreviewTargetProvider),
        franking,
    )
}

fn repo_root() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..5 {
        path.pop();
    }
    path
}

fn tagged_wire(frank_tag: [u8; 32]) -> (String, Uuid, Uuid, Uuid) {
    let raw = std::fs::read_to_string(
        repo_root()
            .join("Documents")
            .join("test-vectors")
            .join("fscp-message-transcript-v1.json"),
    )
    .expect("transcript");
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let mut env: serde_json::Value =
        serde_json::from_str(v["envelopeJsonUtf8"].as_str().unwrap()).unwrap();
    env.as_object_mut().unwrap().insert(
        "frankTagBase64Url".into(),
        serde_json::Value::String(b64(&frank_tag)),
    );
    env.as_object_mut()
        .unwrap()
        .remove("senderSignatureBase64Url");
    let payload = format!(
        "flora.messaging.envelope-signature.v1 | {}",
        flora_messaging::fscp::canonical_json(&env)
    );
    let seed: [u8; 32] = URL_SAFE_NO_PAD
        .decode(v["keys"]["senderSigningSeedBase64Url"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let sig = SigningKey::from_bytes(&seed).sign(payload.as_bytes());
    env.as_object_mut().unwrap().insert(
        "senderSignatureBase64Url".into(),
        serde_json::Value::String(b64(&sig.to_bytes())),
    );
    let wire = format!(
        "fscp1:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_string(&env).unwrap())
    );
    let sender: Uuid = v["uuids"]["senderUserUuid"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let receiver: Uuid = v["uuids"]["receiverUserUuid"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let conv: Uuid = v["uuids"]["conversationUuid"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    (wire, sender, receiver, conv)
}

async fn count_wire(pool: &PgPool, wire: &str) -> i64 {
    sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM flora_core.user_messages
        WHERE encrypted_for_receiver = $1
        "#,
    )
    .bind(wire)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn exclusive_claim_acl_viewer_count_release_reclaim() {
    if !enabled() {
        eprintln!("skip: set FLORA_FRANKING_PG=1");
        return;
    }
    let pool = connect().await;
    let svc = franking(&pool, Some([11u8; 32]));
    let sender = Uuid::now_v7();
    let reporter = Uuid::now_v7();
    let r1 = Uuid::now_v7();
    let r2 = Uuid::now_v7();
    let helper = Uuid::now_v7();
    svc.merge_reviewers(&[r1, r2, helper, sender, reporter])
        .await
        .expect("reviewers");

    let d_reporter = insert_device(&pool, reporter).await;
    let d_r1 = insert_device(&pool, r1).await;
    let d_r2 = insert_device(&pool, r2).await;
    let d_helper = insert_device(&pool, helper).await;
    let d_sender = insert_device(&pool, sender).await;
    let msg = insert_message(&pool, sender, reporter).await;

    assert!(matches!(
        svc.create_report(
            reporter,
            CreateFrankingReportRequest {
                persisted_message_uuid: msg,
                category: FrankingReportCategory::Abuse,
                disclosure_ciphertext: b64(&[1u8; 64]),
                wraps: vec![wrap(reporter, d_reporter), wrap(sender, d_sender)],
            },
        )
        .await,
        Err(FrankingError::BadRequest(_))
    ));

    let created = svc
        .create_report(
            reporter,
            CreateFrankingReportRequest {
                persisted_message_uuid: msg,
                category: FrankingReportCategory::Abuse,
                disclosure_ciphertext: b64(&[1u8; 64]),
                wraps: vec![wrap(reporter, d_reporter), wrap(r1, d_r1), wrap(r2, d_r2)],
            },
        )
        .await
        .expect("create");
    assert_eq!(created.status, FrankingReportStatus::Open);
    assert_eq!(created.viewer_account_count, 2);
    let stranger = Uuid::now_v7();
    assert!(matches!(
        svc.get_report(stranger, created.report_uuid).await,
        Err(FrankingError::NotFound(_))
    ));
    assert!(matches!(
        svc.disclosure(stranger, created.report_uuid).await,
        Err(FrankingError::NotFound(_))
    ));
    assert!(matches!(
        svc.audit(stranger, created.report_uuid).await,
        Err(FrankingError::NotFound(_))
    ));
    assert!(matches!(
        svc.claim(stranger, created.report_uuid).await,
        Err(FrankingError::NotFound(_))
    ));
    assert!(matches!(
        svc.get_report(sender, created.report_uuid).await,
        Err(FrankingError::NotFound(_))
    ));
    assert!(matches!(
        svc.claim(sender, created.report_uuid).await,
        Err(FrankingError::NotFound(_))
    ));
    assert!(matches!(
        svc.claim(reporter, created.report_uuid).await,
        Err(FrankingError::Forbidden(_))
    ));
    assert!(matches!(
        svc.audit(sender, created.report_uuid).await,
        Err(FrankingError::NotFound(_))
    ));
    assert!(matches!(
        svc.audit(reporter, created.report_uuid).await,
        Err(FrankingError::Forbidden(_))
    ));
    let q = svc.queue(r1, None).await.expect("queue");
    assert!(q.items.iter().any(|i| i.report_uuid == created.report_uuid));
    let q_accused = svc.queue(sender, None).await.expect("accused queue");
    assert!(
        q_accused
            .items
            .iter()
            .all(|i| i.report_uuid != created.report_uuid)
    );
    svc.audit(r2, created.report_uuid)
        .await
        .expect("open audit for roster");
    assert_eq!(
        created.verification_status,
        FrankingVerificationStatus::Unverifiable
    );

    let before = svc.disclosure(r1, created.report_uuid).await;
    assert!(matches!(before, Err(FrankingError::Forbidden(_))));

    let claimed = svc.claim(r1, created.report_uuid).await.expect("claim");
    assert_eq!(claimed.status, FrankingReportStatus::Claimed);
    assert_eq!(claimed.claimed_by, Some(r1));
    assert_eq!(claimed.viewer_account_count, 1);
    let reporter_claimed = svc
        .get_report(reporter, created.report_uuid)
        .await
        .expect("reporter meta");
    assert_eq!(reporter_claimed.status, FrankingReportStatus::Claimed);
    assert!(reporter_claimed.claimed_by.is_none());
    assert!(reporter_claimed.claimed_at.is_none());
    assert_eq!(
        svc.get_report(r1, created.report_uuid)
            .await
            .expect("claimer meta")
            .claimed_by,
        Some(r1)
    );
    let q_reporter = svc.queue(reporter, None).await.expect("dual-role queue");
    let own = q_reporter
        .items
        .iter()
        .find(|i| i.report_uuid == created.report_uuid)
        .expect("own report in queue");
    assert!(own.claimed_by.is_none());
    assert!(own.claimed_at.is_none());
    let q_r1 = svc.queue(r1, None).await.expect("claimer queue");
    assert_eq!(
        q_r1.items
            .iter()
            .find(|i| i.report_uuid == created.report_uuid)
            .expect("claimed item")
            .claimed_by,
        Some(r1)
    );
    svc.audit(r1, created.report_uuid)
        .await
        .expect("claimer audit");
    assert!(matches!(
        svc.audit(r2, created.report_uuid).await,
        Err(FrankingError::Forbidden(_))
    ));
    let reporter_wraps: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM flora_core.franking_disclosure_wraps
        WHERE report_uuid = $1 AND user_uuid = $2
        "#,
    )
    .bind(created.report_uuid)
    .bind(reporter)
    .fetch_one(&pool)
    .await
    .expect("backup wraps");
    assert_eq!(reporter_wraps, 1);
    let other_reviewer_wraps: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM flora_core.franking_disclosure_wraps
        WHERE report_uuid = $1 AND user_uuid = $2
        "#,
    )
    .bind(created.report_uuid)
    .bind(r2)
    .fetch_one(&pool)
    .await
    .expect("destroyed roster wraps");
    assert_eq!(other_reviewer_wraps, 0);

    let conv = dm_conversation_uuid(&sender, &reporter);
    let held = MessagingRepo::new(pool.clone())
        .delete_message(sender, conv, msg)
        .await
        .expect("delete while reported");
    assert_eq!(held, DeleteMessageOutcome::Conflict);

    let dup = svc.claim(r2, created.report_uuid).await;
    assert!(matches!(dup, Err(FrankingError::Conflict(_))));

    let r2_disclosure = svc.disclosure(r2, created.report_uuid).await;
    assert!(matches!(r2_disclosure, Err(FrankingError::Forbidden(_))));

    let ok = svc.disclosure(r1, created.report_uuid).await.expect("disc");
    assert!(!ok.disclosure_ciphertext.is_empty());
    assert_eq!(ok.wraps.len(), 1);
    assert!(matches!(
        svc.disclosure(sender, created.report_uuid).await,
        Err(FrankingError::NotFound(_))
    ));

    assert!(matches!(
        svc.forward(
            r1,
            created.report_uuid,
            ForwardFrankingReportRequest {
                wraps: vec![wrap(sender, d_sender)],
            },
        )
        .await,
        Err(FrankingError::BadRequest(_))
    ));

    svc.forward(
        r1,
        created.report_uuid,
        ForwardFrankingReportRequest {
            wraps: vec![wrap(helper, d_helper)],
        },
    )
    .await
    .expect("forward");
    let meta = svc.get_report(r1, created.report_uuid).await.unwrap();
    assert_eq!(meta.viewer_account_count, 2);
    svc.audit(helper, created.report_uuid)
        .await
        .expect("forwarded viewer audit");
    svc.disclosure(helper, created.report_uuid)
        .await
        .expect("helper");
    assert!(matches!(
        svc.disclosure(r2, created.report_uuid).await,
        Err(FrankingError::Forbidden(_))
    ));

    let released = svc.release(r1, created.report_uuid).await.expect("release");
    assert_eq!(released.status, FrankingReportStatus::Open);
    assert!(released.claimed_by.is_none());
    assert!(released.claimed_at.is_none());
    assert_eq!(released.viewer_account_count, 0);
    let (db_claimed_by, db_claimed_at): (Option<Uuid>, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(
            r#"
            SELECT claimed_by, claimed_at
            FROM flora_core.franking_reports
            WHERE report_uuid = $1
            "#,
        )
        .bind(created.report_uuid)
        .fetch_one(&pool)
        .await
        .expect("release columns");
    assert!(db_claimed_by.is_none());
    assert!(db_claimed_at.is_none());

    let awaiting = svc.claim(r2, created.report_uuid).await.expect("reclaim");
    assert_eq!(
        awaiting.status,
        FrankingReportStatus::ClaimedAwaitingDisclosure
    );
    assert_eq!(awaiting.claimed_by, Some(r2));
    let reporter_awaiting = svc
        .get_report(reporter, created.report_uuid)
        .await
        .expect("reporter needs claimer for late wrap");
    assert_eq!(
        reporter_awaiting.status,
        FrankingReportStatus::ClaimedAwaitingDisclosure
    );
    assert_eq!(reporter_awaiting.claimed_by, Some(r2));
    let q_awaiting = svc.queue(reporter, None).await.expect("awaiting queue");
    assert_eq!(
        q_awaiting
            .items
            .iter()
            .find(|i| i.report_uuid == created.report_uuid)
            .expect("awaiting item")
            .claimed_by,
        Some(r2)
    );
    assert!(matches!(
        svc.disclosure(r2, created.report_uuid).await,
        Err(FrankingError::Forbidden(_))
    ));

    let after_wrap = svc
        .add_wraps(
            reporter,
            created.report_uuid,
            PostFrankingWrapsRequest {
                wraps: vec![wrap(r2, d_r2)],
            },
        )
        .await
        .expect("late wrap");
    assert_eq!(after_wrap.status, FrankingReportStatus::Claimed);
    assert!(after_wrap.claimed_by.is_none());
    assert_eq!(
        svc.get_report(r2, created.report_uuid)
            .await
            .expect("claimer still named")
            .claimed_by,
        Some(r2)
    );
    svc.disclosure(r2, created.report_uuid)
        .await
        .expect("after wrap");

    svc.mark_reviewer_roster_unready();
    assert!(matches!(
        svc.get_report(sender, created.report_uuid).await,
        Err(FrankingError::Unavailable(_))
    ));
    assert!(matches!(
        svc.get_report(stranger, created.report_uuid).await,
        Err(FrankingError::Unavailable(_))
    ));
    assert!(matches!(
        svc.get_report(sender, Uuid::now_v7()).await,
        Err(FrankingError::Unavailable(_))
    ));
    svc.get_report(reporter, created.report_uuid)
        .await
        .expect("reporter still sees own report");
    svc.get_report(r2, created.report_uuid)
        .await
        .expect("claimer still sees");

    cleanup(
        &pool,
        &[msg],
        &[r1, r2, helper, sender, reporter],
        &[d_reporter, d_r1, d_r2, d_helper, d_sender],
    )
    .await;
}

#[tokio::test]
async fn reporter_must_be_receiver_and_unknown_message_is_hidden() {
    if !enabled() {
        eprintln!("skip: set FLORA_FRANKING_PG=1");
        return;
    }
    let pool = connect().await;
    let svc = franking(&pool, None);
    let sender = Uuid::now_v7();
    let receiver = Uuid::now_v7();
    let other = Uuid::now_v7();
    let msg = insert_message(&pool, sender, receiver).await;
    let as_sender = svc
        .create_report(
            sender,
            CreateFrankingReportRequest {
                persisted_message_uuid: msg,
                category: FrankingReportCategory::Spam,
                disclosure_ciphertext: b64(&[2u8; 32]),
                wraps: vec![],
            },
        )
        .await;
    assert!(matches!(as_sender, Err(FrankingError::Forbidden(_))));
    let as_stranger = svc
        .create_report(
            other,
            CreateFrankingReportRequest {
                persisted_message_uuid: msg,
                category: FrankingReportCategory::Spam,
                disclosure_ciphertext: b64(&[2u8; 32]),
                wraps: vec![],
            },
        )
        .await;
    assert!(matches!(as_stranger, Err(FrankingError::NotFound(_))));
    let missing = svc
        .create_report(
            other,
            CreateFrankingReportRequest {
                persisted_message_uuid: Uuid::now_v7(),
                category: FrankingReportCategory::Other,
                disclosure_ciphertext: b64(&[2u8; 32]),
                wraps: vec![],
            },
        )
        .await;
    assert!(matches!(missing, Err(FrankingError::NotFound(_))));
    cleanup(&pool, &[msg], &[], &[]).await;
}

#[tokio::test]
async fn tagged_send_fail_closed_and_receipt_on_fetch() {
    if !enabled() {
        eprintln!("skip: set FLORA_FRANKING_PG=1");
        return;
    }
    let pool = connect().await;
    let mut tag = [0xA5u8; 32];
    tag[..16].copy_from_slice(Uuid::now_v7().as_bytes());
    let (wire, sender, receiver, conv) = tagged_wire(tag);
    assert_eq!(dm_conversation_uuid(&sender, &receiver), conv);

    let unsigned = franking(&pool, None);
    let conv_svc = conversations(pool.clone(), Arc::new(unsigned));
    let before = count_wire(&pool, &wire).await;
    let err = conv_svc
        .send_message(
            sender,
            conv,
            PostConversationMessageRequest {
                encrypted_for_receiver: wire.clone(),
                encrypted_for_sender: wire.clone(),
                voice_asset_uuids: vec![],
                image_asset_uuids: vec![],
                video_asset_uuids: vec![],
                encrypted_push_previews: vec![],
                push_preview: None,
            },
        )
        .await;
    assert!(matches!(err, Err(SendMessageError::SigningUnavailable)));
    assert_eq!(
        signing_unavailable_body()["code"],
        "messaging.franking.signing_unavailable"
    );
    assert_eq!(count_wire(&pool, &wire).await, before);

    let seed = [21u8; 32];
    let signed = Arc::new(franking(&pool, Some(seed)));
    let conv_ok = conversations(pool.clone(), signed.clone());
    let sent = conv_ok
        .send_message(
            sender,
            conv,
            PostConversationMessageRequest {
                encrypted_for_receiver: wire.clone(),
                encrypted_for_sender: wire.clone(),
                voice_asset_uuids: vec![],
                image_asset_uuids: vec![],
                video_asset_uuids: vec![],
                encrypted_push_previews: vec![],
                push_preview: None,
            },
        )
        .await
        .expect("tagged send");
    let page = conv_ok
        .messages_page(receiver, conv, Some(sender), None, 20)
        .await
        .unwrap()
        .expect("page");
    let item = page
        .items
        .iter()
        .find(|m| m.message_uuid == sent.message_uuid)
        .expect("item");
    assert!(item.server_frank_receipt.is_some());
    assert_eq!(
        item.frank_tag_base64_url.as_deref(),
        Some(b64(&tag).as_str())
    );

    let reviewer = Uuid::now_v7();
    signed.merge_reviewers(&[reviewer]).await.unwrap();
    let d_rev = insert_device(&pool, reviewer).await;
    let d_rep = insert_device(&pool, receiver).await;
    let report = signed
        .create_report(
            receiver,
            CreateFrankingReportRequest {
                persisted_message_uuid: sent.message_uuid,
                category: FrankingReportCategory::Threats,
                disclosure_ciphertext: b64(&[4u8; 32]),
                wraps: vec![wrap(reviewer, d_rev), wrap(receiver, d_rep)],
            },
        )
        .await
        .expect("report");
    assert_eq!(
        report.verification_status,
        FrankingVerificationStatus::Verifiable
    );
    signed.claim(reviewer, report.report_uuid).await.unwrap();
    let disc = signed
        .disclosure(reviewer, report.report_uuid)
        .await
        .unwrap();
    assert_eq!(
        disc.frank_tag_base64_url.as_deref(),
        item.frank_tag_base64_url.as_deref()
    );
    assert_eq!(
        disc.server_frank_receipt
            .as_ref()
            .map(|r| r.signature_base64_url.as_str()),
        item.server_frank_receipt
            .as_ref()
            .map(|r| r.signature_base64_url.as_str())
    );

    cleanup(&pool, &[sent.message_uuid], &[reviewer], &[d_rev, d_rep]).await;
}

#[tokio::test]
async fn resolve_closes_disclosure() {
    if !enabled() {
        eprintln!("skip: set FLORA_FRANKING_PG=1");
        return;
    }
    let pool = connect().await;
    let svc = franking(&pool, None);
    let sender = Uuid::now_v7();
    let reporter = Uuid::now_v7();
    let reviewer = Uuid::now_v7();
    svc.merge_reviewers(&[reviewer]).await.unwrap();
    let d_rev = insert_device(&pool, reviewer).await;
    let d_rep = insert_device(&pool, reporter).await;
    let msg = insert_message(&pool, sender, reporter).await;
    let created = svc
        .create_report(
            reporter,
            CreateFrankingReportRequest {
                persisted_message_uuid: msg,
                category: FrankingReportCategory::Csam,
                disclosure_ciphertext: b64(&[5u8; 16]),
                wraps: vec![wrap(reviewer, d_rev)],
            },
        )
        .await
        .unwrap();
    svc.claim(reviewer, created.report_uuid).await.unwrap();
    svc.resolve(
        reviewer,
        created.report_uuid,
        ResolveFrankingReportRequest {
            decision: FrankingResolveDecision::Rejected,
            code: Some("no".into()),
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        svc.disclosure(reviewer, created.report_uuid).await,
        Err(FrankingError::Forbidden(_))
    ));
    assert!(matches!(
        svc.add_wraps(
            reporter,
            created.report_uuid,
            PostFrankingWrapsRequest {
                wraps: vec![wrap(reporter, d_rep)],
            },
        )
        .await,
        Err(FrankingError::Forbidden(_))
    ));
    assert!(matches!(
        svc.create_report(
            reporter,
            CreateFrankingReportRequest {
                persisted_message_uuid: msg,
                category: FrankingReportCategory::Csam,
                disclosure_ciphertext: b64(&[6u8; 16]),
                wraps: vec![wrap(reviewer, d_rev)],
            },
        )
        .await,
        Err(FrankingError::Conflict(_))
    ));
    let audit = svc
        .audit(reviewer, created.report_uuid)
        .await
        .expect("audit");
    assert!(
        audit
            .events
            .iter()
            .any(|e| e.event == FrankingAuditEvent::Rejected)
    );
    let conv = dm_conversation_uuid(&sender, &reporter);
    let deleted = MessagingRepo::new(pool.clone())
        .delete_message(sender, conv, msg)
        .await
        .expect("delete after terminal");
    assert_eq!(deleted, DeleteMessageOutcome::Success);
    cleanup(&pool, &[msg], &[reviewer], &[d_rev, d_rep]).await;
}

#[test]
fn insert_receipt_shape_is_64_and_32() {
    let signer = FrankingSigner::from_seed([3u8; 32]);
    let ctx = flora_messaging::fscp::FrankReceiptContextV1 {
        frank_tag_base64_url: b64(&[9u8; 32]),
        message_uuid: Uuid::nil(),
        conversation_uuid: Uuid::nil(),
        sender_user_uuid: Uuid::nil(),
        receiver_user_uuid: Uuid::nil(),
        server_received_at: "2026-01-01T00:00:00.000Z".into(),
    };
    let (payload, sig) = signer.sign(&ctx);
    assert!(!payload.is_empty());
    assert_eq!(sig.len(), 64);
    let _ = InsertFrankReceipt {
        message_uuid: Uuid::nil(),
        wire_message_uuid: Uuid::nil(),
        frank_tag: [9u8; 32],
        receipt_payload: payload,
        signature: sig,
        key_id: signer.key_id(),
        server_received_at: Utc::now(),
    };
}
