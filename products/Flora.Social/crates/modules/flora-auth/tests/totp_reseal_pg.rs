//! PostgreSQL integration для TOTP at-rest (`auth-totp-plaintext`, план §4).
//!
//! Env-gated: требует живой `flora_core` со stub-таблицей `user_accounts`
//! (`scripts/sql/ci-auth-refresh-legacy-schema.sql`). Тесты работают на уровне
//! репозитория и сервисов — без HTTP.
//!
//! Запуск (PowerShell):
//! ```powershell
//! $env:FLORA_AUTH_TOTP_PG = "1"
//! # строка подключения (формат Npgsql) — по умолчанию backend/appsettings.
//! # $env:FLORA_AUTH_TOTP_PG_URL = "Host=localhost;Database=flora_core;Username=...;Password=..."
//! cargo test -p flora-auth --test totp_reseal_pg -- --nocapture --test-threads=1
//! ```
//!
//! **Внимание:** цикл воркера запечатывает ВСЕ legacy plaintext-строки в целевой
//! БД — это его штатное поведение. Поэтому тесты рассчитаны на disposable БД
//! (CI-stub) и дополнительно пропускаются, если в базе есть чужие plaintext-строки
//! (иначе прогон на dev-БД сломал бы 2FA живых аккаунтов).
//!
//! Без `FLORA_AUTH_TOTP_PG=1` все тесты выходят как no-op (skip).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use chrono::Utc;
use flora_auth::application::login::{LoginError, LoginService, SessionHints};
use flora_auth::application::security::SecurityService;
use flora_auth::application::totp_reseal::{ResealStats, TotpResealConfig, run_cycle};
use flora_auth::infrastructure::auth_key_ring::AuthKeyRing;
use flora_auth::infrastructure::jwt::JwtOptions;
use flora_auth::infrastructure::password::hash_password;
use flora_auth::infrastructure::repo::AuthRepo;
use flora_auth::infrastructure::totp::current_totp_code;
use flora_auth::infrastructure::totp_at_rest::TotpAtRest;
use flora_shared::config::FloraConfig;
use flora_shared::npgsql::NpgsqlConnectionString;
use flora_users_contracts::{BoxFuture as UserBoxFuture, UserProfileReadQueries};
use flora_verification_contracts::{
    BoxFuture, ChallengeBeginResult, ChallengeValidateResult, VerificationChallengePort,
};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

const KEY_LEN: usize = 32;
const PLAINTEXT_SECRET: &str = "JBSWY3DPEHPK3PXN";
const PASSWORD: &str = "totp-pg-password";

fn enabled() -> bool {
    std::env::var("FLORA_AUTH_TOTP_PG").ok().as_deref() == Some("1")
}

/// Argon2id дорогой (64 MiB × 4): хэш считается один раз на процесс.
fn password_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| hash_password(PASSWORD))
}

fn at_rest(keys: &[(&str, u8)], active: &str) -> TotpAtRest {
    let keys: HashMap<String, [u8; KEY_LEN]> = keys
        .iter()
        .map(|(id, byte)| ((*id).to_string(), [*byte; KEY_LEN]))
        .collect();
    TotpAtRest::Sealed(AuthKeyRing::new(active, keys).unwrap())
}

fn config(batch_limit: i64) -> TotpResealConfig {
    TotpResealConfig {
        interval: std::time::Duration::from_secs(60),
        batch_limit,
        max_batches_per_cycle: 20,
    }
}

async fn connect() -> PgPool {
    let raw = if let Ok(url) = std::env::var("FLORA_AUTH_TOTP_PG_URL") {
        url
    } else {
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for _ in 0..5 {
            path.pop();
        }
        path.push("backend");
        let cfg = FloraConfig::load("Development", &path).expect("backend/appsettings");
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
    if let Some(search_path) = &parsed.search_path {
        options = options.options([("search_path", search_path.as_str())]);
    }
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .expect("connect postgres")
}

/// E-mail аккаунта в тестах: `insert_account` и login-кейс пользуются одним правилом.
fn email_for(user_uuid: Uuid) -> String {
    format!("{user_uuid}@totp.test")
}

/// Аккаунт с заданным TOTP-секретом (`None` — без секрета).
/// E-mail и телефон уникальны на аккаунт: в живой схеме на них могут стоять
/// unique-индексы.
async fn insert_account(
    pool: &PgPool,
    two_factor_secret: Option<&str>,
    two_factor_enabled: bool,
) -> Uuid {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);

    let user_uuid = Uuid::now_v7();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_accounts (
            user_uuid, username, updated_at, password_hash, email, phone,
            phone_verified, status, two_factor_enabled, two_factor_secret
        ) VALUES ($1,$2,now(),$3,$4,$5,false,0,$6,$7)
        "#,
    )
    .bind(user_uuid)
    .bind(format!("totp-pg-{user_uuid}"))
    .bind(password_hash())
    .bind(email_for(user_uuid))
    .bind(format!("79{seq:09}"))
    .bind(two_factor_enabled)
    .bind(two_factor_secret)
    .execute(pool)
    .await
    .expect("insert account");
    user_uuid
}

async fn set_secret(pool: &PgPool, user_uuid: Uuid, secret: &str) {
    sqlx::query("UPDATE flora_core.user_accounts SET two_factor_secret = $2 WHERE user_uuid = $1")
        .bind(user_uuid)
        .bind(secret)
        .execute(pool)
        .await
        .expect("update secret");
}

async fn stored_secret(pool: &PgPool, user_uuid: Uuid) -> Option<String> {
    sqlx::query_scalar(
        "SELECT two_factor_secret FROM flora_core.user_accounts WHERE user_uuid = $1",
    )
    .bind(user_uuid)
    .fetch_one(pool)
    .await
    .expect("select secret")
}

async fn two_factor_enabled(pool: &PgPool, user_uuid: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT two_factor_enabled FROM flora_core.user_accounts WHERE user_uuid = $1",
    )
    .bind(user_uuid)
    .fetch_one(pool)
    .await
    .expect("select flag")
}

/// Строка lockout-счётчика: `None` — строки нет (попыток не было).
async fn login_failures(pool: &PgPool, user_uuid: Uuid) -> Option<i16> {
    sqlx::query_scalar(
        "SELECT login_failures::smallint FROM flora_core.user_security_logs WHERE user_uuid = $1",
    )
    .bind(user_uuid)
    .fetch_optional(pool)
    .await
    .expect("select login failures")
}

async fn seed_security_log(pool: &PgPool, user_uuid: Uuid) {
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_security_logs (
            user_uuid, password_updated_at, login_failures, login_locked_until, created_at, updated_at
        ) VALUES ($1, now(), 0, NULL, now(), now())
        ON CONFLICT (user_uuid) DO NOTHING
        "#,
    )
    .bind(user_uuid)
    .execute(pool)
    .await
    .expect("seed security log");
}

async fn cleanup(pool: &PgPool, users: &[Uuid]) {
    for user_uuid in users {
        let _ = sqlx::query("DELETE FROM flora_core.user_security_logs WHERE user_uuid = $1")
            .bind(user_uuid)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM flora_core.user_accounts WHERE user_uuid = $1")
            .bind(user_uuid)
            .execute(pool)
            .await;
    }
}

/// Защита dev-БД: цикл запечатывает и ротирует секреты всей таблицы, поэтому при
/// любых чужих TOTP-строках тест не запускается.
async fn has_foreign_totp_rows(pool: &PgPool, own: &[Uuid]) -> bool {
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT count(*)
        FROM flora_core.user_accounts
        WHERE two_factor_secret IS NOT NULL AND two_factor_secret <> ''
          AND NOT (user_uuid = ANY($1::uuid[]))
        "#,
    )
    .bind(own)
    .fetch_one(pool)
    .await
    .expect("count foreign totp rows");
    count > 0
}

fn assert_skipped(own: &[Uuid]) {
    eprintln!(
        "skip: в БД есть чужие TOTP-секреты (свои: {}), цикл воркера затронул бы их",
        own.len()
    );
}

struct NoProfiles;

impl UserProfileReadQueries for NoProfiles {
    fn requires_profile_completion(
        &self,
        _user_uuid: Uuid,
    ) -> UserBoxFuture<'_, Result<bool, String>> {
        Box::pin(async { Ok(false) })
    }
}

struct NoVerification;

impl VerificationChallengePort for NoVerification {
    fn begin(
        &self,
        _kind: i32,
        _target: &str,
        _subject_user_uuid: Option<Uuid>,
    ) -> BoxFuture<'_, Result<ChallengeBeginResult, String>> {
        Box::pin(async {
            Err("verification не используется в тестах 2FA".into())
        })
    }

    fn validate(
        &self,
        _token: Uuid,
        _code_plain: &str,
    ) -> BoxFuture<'_, Result<ChallengeValidateResult, String>> {
        Box::pin(async {
            Err("verification не используется в тестах 2FA".into())
        })
    }

    fn cancel(&self, _token: Uuid) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn backfill_seals_plaintext_rows_across_keyset_pages() {
    if !enabled() {
        return;
    }
    let pool = connect().await;
    let repo = AuthRepo::new(pool.clone());
    let at_rest = at_rest(&[("k1", 11)], "k1");

    let mut users = Vec::new();
    for _ in 0..5 {
        users.push(insert_account(&pool, Some(PLAINTEXT_SECRET), false).await);
    }
    if has_foreign_totp_rows(&pool, &users).await {
        assert_skipped(&users);
        cleanup(&pool, &users).await;
        return;
    }

    // batch_limit=2 при 5 строках → минимум 3 keyset-страницы.
    let stats = run_cycle(&repo, &at_rest, &config(2)).await;
    assert_eq!(stats.sealed, 5, "все страницы пройдены: {stats:?}");
    for user_uuid in &users {
        let stored = stored_secret(&pool, *user_uuid).await.unwrap_or_default();
        assert!(stored.starts_with("v1:k1:"), "строка {user_uuid}: {stored}");
        assert_eq!(at_rest.open(*user_uuid, &stored).unwrap(), PLAINTEXT_SECRET);
    }
    cleanup(&pool, &users).await;
}

#[tokio::test]
async fn cas_does_not_overwrite_changed_row() {
    if !enabled() {
        return;
    }
    let pool = connect().await;
    let repo = AuthRepo::new(pool.clone());
    let user_uuid = insert_account(&pool, Some("AAAA"), false).await;

    let stale = repo
        .compare_and_swap_two_factor_secret(user_uuid, "BBBB", "CCCC", Utc::now())
        .await
        .expect("cas stale");
    assert!(!stale, "CAS по устаревшему значению не проходит");
    assert_eq!(
        stored_secret(&pool, user_uuid).await.as_deref(),
        Some("AAAA")
    );

    let fresh = repo
        .compare_and_swap_two_factor_secret(user_uuid, "AAAA", "CCCC", Utc::now())
        .await
        .expect("cas fresh");
    assert!(fresh, "CAS по актуальному значению проходит");
    assert_eq!(
        stored_secret(&pool, user_uuid).await.as_deref(),
        Some("CCCC")
    );

    cleanup(&pool, &[user_uuid]).await;
}

#[tokio::test]
async fn repeated_cycle_is_noop() {
    if !enabled() {
        return;
    }
    let pool = connect().await;
    let repo = AuthRepo::new(pool.clone());
    let at_rest = at_rest(&[("k1", 11)], "k1");

    let mut users = Vec::new();
    for _ in 0..3 {
        users.push(insert_account(&pool, Some(PLAINTEXT_SECRET), false).await);
    }
    if has_foreign_totp_rows(&pool, &users).await {
        assert_skipped(&users);
        cleanup(&pool, &users).await;
        return;
    }

    let first = run_cycle(&repo, &at_rest, &config(2)).await;
    let second = run_cycle(&repo, &at_rest, &config(2)).await;
    cleanup(&pool, &users).await;

    assert_eq!(first.sealed, 3);
    assert_eq!(second, ResealStats::default(), "повторный прогон — no-op");
}

#[tokio::test]
async fn rotation_reseals_rows_under_active_key() {
    if !enabled() {
        return;
    }
    let pool = connect().await;
    let repo = AuthRepo::new(pool.clone());
    let old = at_rest(&[("k-old", 3)], "k-old");
    let rotated = at_rest(&[("k-old", 3), ("k-new", 4)], "k-new");

    let mut users = Vec::new();
    for _ in 0..3 {
        let user_uuid = insert_account(&pool, Some("placeholder"), true).await;
        set_secret(&pool, user_uuid, &old.seal(user_uuid, PLAINTEXT_SECRET)).await;
        users.push(user_uuid);
    }
    if has_foreign_totp_rows(&pool, &users).await {
        assert_skipped(&users);
        cleanup(&pool, &users).await;
        return;
    }

    let stats = run_cycle(&repo, &rotated, &config(2)).await;
    assert_eq!(
        stats.resealed, 3,
        "ротация переселила все строки: {stats:?}"
    );
    for user_uuid in &users {
        let stored = stored_secret(&pool, *user_uuid).await.unwrap_or_default();
        assert!(
            stored.starts_with("v1:k-new:"),
            "строка {user_uuid}: {stored}"
        );
        assert_eq!(rotated.open(*user_uuid, &stored).unwrap(), PLAINTEXT_SECRET);
    }
    cleanup(&pool, &users).await;
}

#[tokio::test]
async fn rotation_compares_key_ids_exactly_not_as_like_patterns() {
    if !enabled() {
        return;
    }
    let pool = connect().await;
    let repo = AuthRepo::new(pool.clone());
    // Активный id содержит '_' (в LIKE — wildcard на один символ), выводимый id
    // отличается только этим символом. Точное сравнение обязано их различить.
    let old = at_rest(&[("kx1", 3)], "kx1");
    let rotated = at_rest(&[("kx1", 3), ("k_1", 4)], "k_1");

    let mut users = Vec::new();
    for _ in 0..2 {
        let user_uuid = insert_account(&pool, Some("placeholder"), true).await;
        set_secret(&pool, user_uuid, &old.seal(user_uuid, PLAINTEXT_SECRET)).await;
        users.push(user_uuid);
    }
    if has_foreign_totp_rows(&pool, &users).await {
        assert_skipped(&users);
        cleanup(&pool, &users).await;
        return;
    }

    let stats = run_cycle(&repo, &rotated, &config(10)).await;
    assert_eq!(stats.resealed, 2, "wildcard не спрятал строки: {stats:?}");
    for user_uuid in &users {
        let stored = stored_secret(&pool, *user_uuid).await.unwrap_or_default();
        assert!(
            stored.starts_with("v1:k_1:"),
            "строка {user_uuid} осталась под старым id: {stored}"
        );
    }
    cleanup(&pool, &users).await;
}

#[tokio::test]
async fn setup_then_worker_then_enable_confirms_sealed_secret() {
    if !enabled() {
        return;
    }
    let pool = connect().await;
    let repo = Arc::new(AuthRepo::new(pool.clone()));
    let at_rest = Arc::new(at_rest(&[("k1", 11)], "k1"));
    let security = SecurityService::new(repo.clone(), Arc::new(NoVerification), at_rest.clone());
    let user_uuid = insert_account(&pool, None, false).await;
    if has_foreign_totp_rows(&pool, &[user_uuid]).await {
        assert_skipped(&[user_uuid]);
        cleanup(&pool, &[user_uuid]).await;
        return;
    }

    let setup = security
        .begin_two_factor_setup(user_uuid, PASSWORD)
        .await
        .expect("begin two factor setup");
    let stored_after_setup = stored_secret(&pool, user_uuid).await.unwrap_or_default();
    assert!(
        stored_after_setup.starts_with("v1:k1:"),
        "setup пишет sealed-значение: {stored_after_setup}"
    );
    assert!(
        !setup.secret.starts_with("v1:") && setup.secret.len() == 32,
        "клиенту отдаётся base32 из памяти: {}",
        setup.secret
    );

    // Воркер не трогает уже запечатанную строку.
    let stats = run_cycle(&repo, &at_rest, &config(10)).await;
    assert_eq!(stats.sealed, 0);
    assert_eq!(
        stored_secret(&pool, user_uuid).await.as_deref(),
        Some(stored_after_setup.as_str())
    );

    let code = current_totp_code(&setup.secret).expect("totp code from setup secret");
    security
        .enable_two_factor(user_uuid, &code)
        .await
        .expect("enable two factor by sealed secret");
    assert!(two_factor_enabled(&pool, user_uuid).await);

    cleanup(&pool, &[user_uuid]).await;
}

/// Sealed-строка при отсутствующем key ring: вход даёт 5xx и **не** двигает
/// lockout-счётчик. Единственное место, где порядок «unseal до `register_failure`»
/// проверяется на живом login-пути.
#[tokio::test]
async fn login_with_sealed_secret_and_no_key_ring_is_internal_without_lockout() {
    if !enabled() {
        return;
    }
    let pool = connect().await;
    let repo = Arc::new(AuthRepo::new(pool.clone()));
    let key_ring = at_rest(&[("k1", 11)], "k1");
    let user_uuid = insert_account(&pool, None, true).await;
    set_secret(
        &pool,
        user_uuid,
        &key_ring.seal(user_uuid, PLAINTEXT_SECRET),
    )
    .await;
    seed_security_log(&pool, user_uuid).await;

    let login = LoginService::new(
        repo,
        JwtOptions::from_config(&FloraConfig::default()),
        Arc::new(NoProfiles),
        Arc::new(TotpAtRest::plain()),
    );
    let email = email_for(user_uuid);
    let error = login
        .login(
            Some(&email),
            None,
            PASSWORD,
            Some("123456"),
            SessionHints {
                ip: "127.0.0.1".into(),
                agent_hash: "totp-pg".into(),
            },
        )
        .await
        .expect_err("sealed-секрет без key ring");

    match error {
        // Текст отличает ветку unseal от более ранних SQL-ошибок login-пути.
        LoginError::Internal(reason) => assert!(
            reason.contains("TotpKeyRing"),
            "ожидалась ошибка key ring, получено: {reason}"
        ),
        other => panic!("ожидался LoginError::Internal, получено {other:?}"),
    }
    assert_eq!(
        login_failures(&pool, user_uuid).await,
        Some(0),
        "недоступность ключа не должна инкрементить lockout-счётчик"
    );

    cleanup(&pool, &[user_uuid]).await;
}
