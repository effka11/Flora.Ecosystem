//! PostgreSQL integration для retry-safe refresh (plan §1, bullet 2).
//!
//! Env-gated: требует живой `flora_core` со схемой `user_sessions` (и применённой
//! additive-миграцией `auth_refresh_replays`). Тесты работают на уровне репозитория
//! [`AuthRepo::rotate_or_replay`] — без user_accounts/profiles/HTTP.
//!
//! Запуск (PowerShell):
//! ```powershell
//! $env:FLORA_AUTH_REPLAY_PG = "1"
//! # строка подключения (формат Npgsql) — по умолчанию Backend/appsettings.
//! # $env:FLORA_AUTH_REPLAY_PG_URL = "Host=localhost;Database=flora_core;Username=...;Password=..."
//! cargo test -p flora-auth --test refresh_replays_pg -- --nocapture --test-threads=1
//! ```
//! Без `FLORA_AUTH_REPLAY_PG=1` все тесты выходят как no-op (skip).

use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{Duration, Utc};
use flora_auth::application::replay_grant::{ReplayGrantV1, replay_aad};
use flora_auth::http::LoginResponse;
use flora_auth::infrastructure::replay_keys::ReplayKeyRing;
use flora_auth::infrastructure::repo::{AuthRepo, PreparedGrant, RefreshOutcome, StoredGrant};
use flora_auth::infrastructure::tokens::{
    generate_jwt_id, generate_refresh_token, hash_refresh_token,
};
use flora_shared::config::FloraConfig;
use flora_shared::npgsql::NpgsqlConnectionString;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

const SECRET: &[u8] = b"replay-pg-refresh-signing-key-0123456789";
const GRACE: i64 = 60;

fn enabled() -> bool {
    std::env::var("FLORA_AUTH_REPLAY_PG").ok().as_deref() == Some("1")
}

fn key_ring() -> ReplayKeyRing {
    let mut keys = HashMap::new();
    keys.insert("k1".to_string(), [11_u8; 32]);
    ReplayKeyRing::new("k1", keys).unwrap()
}

fn rotated_key_ring() -> ReplayKeyRing {
    // k1 остаётся decrypt-only, активным становится k2.
    let mut keys = HashMap::new();
    keys.insert("k1".to_string(), [11_u8; 32]);
    keys.insert("k2".to_string(), [22_u8; 32]);
    ReplayKeyRing::new("k2", keys).unwrap()
}

async fn connect() -> PgPool {
    let raw = if let Ok(url) = std::env::var("FLORA_AUTH_REPLAY_PG_URL") {
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
    if let Some(search_path) = &parsed.search_path {
        options = options.options([("search_path", search_path.as_str())]);
    }
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .expect("connect postgres")
}

/// Применить additive-миграцию (idempotent, IF NOT EXISTS).
async fn ensure_schema(pool: &PgPool) {
    let sql = include_str!("../migrations/0001_refresh_replays.sql");
    sqlx::raw_sql(sql)
        .execute(pool)
        .await
        .expect("apply replay migration");
}

async fn insert_session(
    pool: &PgPool,
    session_id: Uuid,
    refresh_stored: &str,
    rotation: i64,
) -> Uuid {
    let user_uuid = Uuid::now_v7();
    let now = Utc::now();
    let expires = now + Duration::days(7);
    sqlx::query(
        r#"
        INSERT INTO flora_core.user_sessions (
            session_id, user_uuid, agent_hash, ip_address,
            created_at, expires_at, last_activity,
            jwt_id, refresh_token, rotation_id, status,
            csrf_token, hmac_key
        ) VALUES ($1,$2,'replay-pg','127.0.0.1',$3,$4,$3,$5,$6,$7,0,'csrf','hmac')
        "#,
    )
    .bind(session_id)
    .bind(user_uuid)
    .bind(now)
    .bind(expires)
    .bind(generate_jwt_id())
    .bind(refresh_stored)
    .bind(rotation)
    .execute(pool)
    .await
    .expect("insert session");
    user_uuid
}

async fn cleanup(pool: &PgPool, session_id: Uuid) {
    let _ = sqlx::query("DELETE FROM flora_core.auth_refresh_replays WHERE session_id = $1")
        .bind(session_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM flora_core.user_sessions WHERE session_id = $1")
        .bind(session_id)
        .execute(pool)
        .await;
}

/// Собрать прогнозный R2 (как это делает сервис) и вернуть grant + ожидаемый ответ.
fn prepare(
    session_id: Uuid,
    presented_token: &str,
    expected_rotation: i64,
    ring: &ReplayKeyRing,
) -> (PreparedGrant, LoginResponse) {
    let now = Utc::now();
    let new_refresh = generate_refresh_token(session_id, SECRET);
    let refresh_expires = now + Duration::days(7);
    let new_rotation = expected_rotation + 1;
    let response = LoginResponse {
        access_token: format!("access-{new_rotation}"),
        refresh_token: new_refresh.clone(),
        expires_at: "2026-07-24T12:15:00.000Z".into(),
        token_type: "Bearer".into(),
        requires_profile_completion: false,
    };
    let presented_hash = hash_refresh_token(presented_token);
    let new_refresh_hash = hash_refresh_token(&new_refresh);
    let aad = replay_aad(
        session_id,
        new_rotation,
        &presented_hash,
        &new_refresh_hash,
        refresh_expires,
    );
    let sealed = ring.seal(&aad, &ReplayGrantV1::from_response(&response).encode());
    (
        PreparedGrant {
            expected_rotation_id: expected_rotation,
            new_rotation_id: new_rotation,
            new_jwt_id: generate_jwt_id(),
            new_refresh_hash,
            refresh_expires_at: refresh_expires,
            spent_hash: presented_hash,
            key_id: sealed.key_id,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            version: 1,
        },
        response,
    )
}

fn open_stored(ring: &ReplayKeyRing, stored: &StoredGrant) -> LoginResponse {
    let aad = replay_aad(
        stored.session_id,
        stored.replacement_rotation_id,
        &stored.spent_hash,
        &stored.replacement_hash,
        stored.refresh_expires_at,
    );
    let plaintext = ring
        .open(&stored.key_id, &stored.nonce, &aad, &stored.ciphertext)
        .expect("decrypt replay grant");
    ReplayGrantV1::decode(&plaintext).unwrap().into_response()
}

#[tokio::test]
async fn rotate_then_replay_and_grace_barrier() {
    if !enabled() {
        eprintln!("skip: set FLORA_AUTH_REPLAY_PG=1");
        return;
    }
    let pool = connect().await;
    ensure_schema(&pool).await;
    let ring = key_ring();
    let session_id = Uuid::now_v7();

    let r1 = generate_refresh_token(session_id, SECRET);
    insert_session(&pool, session_id, &hash_refresh_token(&r1), 0).await;

    // R1 -> R2 (Rotate).
    let (grant, r2_response) = prepare(session_id, &r1, 0, &ring);
    let out = pool_rotate(&pool, session_id, &r1, &grant).await;
    assert!(
        matches!(out, RefreshOutcome::Rotated { .. }),
        "first R1 rotates"
    );
    let r2 = r2_response.refresh_token.clone();

    // Повтор R1 в grace -> Replayed, ровно R2.
    let (grant2, _) = prepare(session_id, &r1, 1, &ring);
    let out = pool_rotate(&pool, session_id, &r1, &grant2).await;
    match out {
        RefreshOutcome::Replayed(stored) => {
            assert_eq!(open_stored(&ring, &stored).refresh_token, r2);
        }
        other => panic!("expected Replayed, got {other:?}"),
    }

    // Барьер: текущий R2 в grace -> Replayed, тот же R2 (без R3).
    let (grant3, _) = prepare(session_id, &r2, 1, &ring);
    let out = pool_rotate(&pool, session_id, &r2, &grant3).await;
    match out {
        RefreshOutcome::Replayed(stored) => {
            assert_eq!(open_stored(&ring, &stored).refresh_token, r2);
        }
        other => panic!("expected barrier Replayed, got {other:?}"),
    }

    let rotation: i64 =
        sqlx::query_scalar("SELECT rotation_id FROM flora_core.user_sessions WHERE session_id=$1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rotation, 1, "grace barrier не крутит rotation");

    cleanup(&pool, session_id).await;
}

#[tokio::test]
async fn reuse_after_grace_revokes_session() {
    if !enabled() {
        eprintln!("skip: set FLORA_AUTH_REPLAY_PG=1");
        return;
    }
    let pool = connect().await;
    ensure_schema(&pool).await;
    let ring = key_ring();
    let session_id = Uuid::now_v7();
    let r1 = generate_refresh_token(session_id, SECRET);
    insert_session(&pool, session_id, &hash_refresh_token(&r1), 0).await;

    let (grant, _) = prepare(session_id, &r1, 0, &ring);
    assert!(matches!(
        pool_rotate(&pool, session_id, &r1, &grant).await,
        RefreshOutcome::Rotated { .. }
    ));

    // Форсируем истечение grace.
    sqlx::query("UPDATE flora_core.auth_refresh_replays SET valid_until = now() - interval '1 second' WHERE session_id=$1")
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();

    let (grant2, _) = prepare(session_id, &r1, 1, &ring);
    let out = pool_rotate(&pool, session_id, &r1, &grant2).await;
    assert!(matches!(out, RefreshOutcome::ReusedOutsideGrace));

    let status: i32 =
        sqlx::query_scalar("SELECT status FROM flora_core.user_sessions WHERE session_id=$1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, 4, "RevokedUser после reuse вне grace");
    cleanup(&pool, session_id).await;
}

#[tokio::test]
async fn legacy_raw_token_first_rotation() {
    if !enabled() {
        eprintln!("skip: set FLORA_AUTH_REPLAY_PG=1");
        return;
    }
    let pool = connect().await;
    ensure_schema(&pool).await;
    let ring = key_ring();
    let session_id = Uuid::now_v7();

    // Legacy: сырой refresh (не sha256:), без HMAC-привязки.
    let raw = format!("legacy-raw-{session_id}");
    insert_session(&pool, session_id, &raw, 0).await;

    // Fallback находит session_id по сырому токену.
    let found = AuthRepo::new(pool.clone())
        .find_session_id_by_refresh(&raw, Utc::now())
        .await
        .unwrap();
    assert_eq!(found, Some(session_id));

    let (grant, _) = prepare(session_id, &raw, 0, &ring);
    let repo = AuthRepo::new(pool.clone());
    let out = repo
        .rotate_or_replay(
            session_id,
            &raw,
            &hash_refresh_token(&raw),
            false,
            &grant,
            GRACE,
            false,
        )
        .await
        .unwrap();
    assert!(
        matches!(out, RefreshOutcome::Rotated { .. }),
        "legacy raw rotates"
    );

    let stored: String = sqlx::query_scalar(
        "SELECT refresh_token FROM flora_core.user_sessions WHERE session_id=$1",
    )
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        stored.starts_with("sha256:"),
        "после ротации хранится hashed токен"
    );
    cleanup(&pool, session_id).await;
}

#[tokio::test]
async fn key_rotation_decrypts_and_corruption_is_transient() {
    if !enabled() {
        eprintln!("skip: set FLORA_AUTH_REPLAY_PG=1");
        return;
    }
    let pool = connect().await;
    ensure_schema(&pool).await;
    let ring = key_ring();
    let session_id = Uuid::now_v7();
    let r1 = generate_refresh_token(session_id, SECRET);
    insert_session(&pool, session_id, &hash_refresh_token(&r1), 0).await;

    let (grant, r2_response) = prepare(session_id, &r1, 0, &ring);
    assert!(matches!(
        pool_rotate(&pool, session_id, &r1, &grant).await,
        RefreshOutcome::Rotated { .. }
    ));

    // Ключ ротирован: k1 decrypt-only, активен k2. Старый grant всё ещё читается.
    let rotated = rotated_key_ring();
    let (grant2, _) = prepare(session_id, &r1, 1, &ring);
    match pool_rotate(&pool, session_id, &r1, &grant2).await {
        RefreshOutcome::Replayed(stored) => {
            assert_eq!(stored.key_id, "k1");
            assert_eq!(
                open_stored(&rotated, &stored).refresh_token,
                r2_response.refresh_token
            );
        }
        other => panic!("expected Replayed, got {other:?}"),
    }

    // Corruption: портим ciphertext -> open даёт ошибку (сервис вернул бы 5xx),
    // но НИКОГДА не ложный revoke.
    sqlx::query("UPDATE flora_core.auth_refresh_replays SET ciphertext = decode('00','hex') WHERE session_id=$1")
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();
    let (grant3, _) = prepare(session_id, &r1, 1, &ring);
    match pool_rotate(&pool, session_id, &r1, &grant3).await {
        RefreshOutcome::Replayed(stored) => {
            assert!(
                ring.open(
                    &stored.key_id,
                    &stored.nonce,
                    &replay_aad(
                        stored.session_id,
                        stored.replacement_rotation_id,
                        &stored.spent_hash,
                        &stored.replacement_hash,
                        stored.refresh_expires_at,
                    ),
                    &stored.ciphertext
                )
                .is_err()
            );
        }
        other => panic!("expected Replayed (corrupt), got {other:?}"),
    }
    let status: i32 =
        sqlx::query_scalar("SELECT status FROM flora_core.user_sessions WHERE session_id=$1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, 0, "corruption не отзывает сессию");
    cleanup(&pool, session_id).await;
}

#[tokio::test]
async fn logout_and_password_change_during_grace_beat_replay() {
    if !enabled() {
        eprintln!("skip: set FLORA_AUTH_REPLAY_PG=1");
        return;
    }
    let pool = connect().await;
    ensure_schema(&pool).await;
    let ring = key_ring();

    for revoked_status in [4_i32, 2_i32] {
        let session_id = Uuid::now_v7();
        let r1 = generate_refresh_token(session_id, SECRET);
        insert_session(&pool, session_id, &hash_refresh_token(&r1), 0).await;
        let (grant, _) = prepare(session_id, &r1, 0, &ring);
        assert!(matches!(
            pool_rotate(&pool, session_id, &r1, &grant).await,
            RefreshOutcome::Rotated { .. }
        ));

        // logout / revoke-others / password-change отзывает сессию в пределах grace.
        sqlx::query("UPDATE flora_core.user_sessions SET status=$1 WHERE session_id=$2")
            .bind(revoked_status)
            .bind(session_id)
            .execute(&pool)
            .await
            .unwrap();

        let (grant2, _) = prepare(session_id, &r1, 1, &ring);
        let out = pool_rotate(&pool, session_id, &r1, &grant2).await;
        assert!(
            matches!(out, RefreshOutcome::Invalid),
            "revoked session не воскрешается replay ({revoked_status})"
        );
        cleanup(&pool, session_id).await;
    }
}

#[tokio::test]
async fn bounded_cleanup_removes_only_expired() {
    if !enabled() {
        eprintln!("skip: set FLORA_AUTH_REPLAY_PG=1");
        return;
    }
    let pool = connect().await;
    ensure_schema(&pool).await;
    let ring = key_ring();

    // Свежий replay (не должен быть удалён).
    let fresh_session = Uuid::now_v7();
    let fresh_r1 = generate_refresh_token(fresh_session, SECRET);
    insert_session(&pool, fresh_session, &hash_refresh_token(&fresh_r1), 0).await;
    let (fresh_grant, _) = prepare(fresh_session, &fresh_r1, 0, &ring);
    pool_rotate(&pool, fresh_session, &fresh_r1, &fresh_grant).await;

    // Истёкший replay.
    let expired_session = Uuid::now_v7();
    let expired_r1 = generate_refresh_token(expired_session, SECRET);
    insert_session(&pool, expired_session, &hash_refresh_token(&expired_r1), 0).await;
    let (expired_grant, _) = prepare(expired_session, &expired_r1, 0, &ring);
    pool_rotate(&pool, expired_session, &expired_r1, &expired_grant).await;
    sqlx::query("UPDATE flora_core.auth_refresh_replays SET valid_until = now() - interval '1 hour' WHERE session_id=$1")
        .bind(expired_session)
        .execute(&pool)
        .await
        .unwrap();

    let removed = AuthRepo::new(pool.clone())
        .cleanup_expired_replays(Utc::now(), 100)
        .await
        .unwrap();
    assert!(removed >= 1, "истёкшие replay удалены");

    let fresh_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM flora_core.auth_refresh_replays WHERE session_id=$1)",
    )
    .bind(fresh_session)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(fresh_exists, "свежий replay сохранён");
    let expired_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM flora_core.auth_refresh_replays WHERE session_id=$1)",
    )
    .bind(expired_session)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!expired_exists, "истёкший replay удалён");

    cleanup(&pool, fresh_session).await;
    cleanup(&pool, expired_session).await;
}

#[tokio::test]
async fn drain_blocks_new_rotation_but_serves_replay_in_grace() {
    if !enabled() {
        eprintln!("skip: set FLORA_AUTH_REPLAY_PG=1");
        return;
    }
    let pool = connect().await;
    ensure_schema(&pool).await;
    let ring = key_ring();
    let session_id = Uuid::now_v7();
    let r1 = generate_refresh_token(session_id, SECRET);
    insert_session(&pool, session_id, &hash_refresh_token(&r1), 0).await;

    // R1 -> R2 до входа в drain.
    let (grant, r2_response) = prepare(session_id, &r1, 0, &ring);
    assert!(matches!(
        pool_rotate(&pool, session_id, &r1, &grant).await,
        RefreshOutcome::Rotated { .. }
    ));
    let r2 = r2_response.refresh_token.clone();

    // Drain: повтор R1 в grace всё ещё обслуживается (Replayed, ровно R2).
    let (grant2, _) = prepare(session_id, &r1, 1, &ring);
    match pool_rotate_drain(&pool, session_id, &r1, &grant2, true).await {
        RefreshOutcome::Replayed(stored) => {
            assert_eq!(open_stored(&ring, &stored).refresh_token, r2);
        }
        other => panic!("expected Replayed in drain, got {other:?}"),
    }

    // Drain: текущий R2 после grace потребовал бы новую ротацию → Draining (503),
    // строка НЕ мутируется (rotation_id и статус неизменны).
    sqlx::query("UPDATE flora_core.auth_refresh_replays SET valid_until = now() - interval '1 second' WHERE session_id=$1")
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();
    let (grant3, _) = prepare(session_id, &r2, 1, &ring);
    assert!(matches!(
        pool_rotate_drain(&pool, session_id, &r2, &grant3, true).await,
        RefreshOutcome::Draining
    ));
    let (rotation, status): (i64, i32) = sqlx::query_as(
        "SELECT rotation_id, status FROM flora_core.user_sessions WHERE session_id=$1",
    )
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rotation, 1, "drain не крутит rotation");
    assert_eq!(status, 0, "drain не отзывает сессию (никогда false-revoke)");

    // Reuse вне grace в drain тоже 503 без отзыва (never false revoke).
    let (grant4, _) = prepare(session_id, &r1, 1, &ring);
    assert!(matches!(
        pool_rotate_drain(&pool, session_id, &r1, &grant4, true).await,
        RefreshOutcome::Draining
    ));
    let status: i32 =
        sqlx::query_scalar("SELECT status FROM flora_core.user_sessions WHERE session_id=$1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, 0, "drain reuse не отзывает сессию");

    cleanup(&pool, session_id).await;
}

#[tokio::test]
async fn logout_by_session_id_survives_concurrent_jti_rotation() {
    if !enabled() {
        eprintln!("skip: set FLORA_AUTH_REPLAY_PG=1");
        return;
    }
    let pool = connect().await;
    ensure_schema(&pool).await;
    let ring = key_ring();
    let repo = AuthRepo::new(pool.clone());
    let session_id = Uuid::now_v7();
    let r1 = generate_refresh_token(session_id, SECRET);
    let user_uuid = insert_session(&pool, session_id, &hash_refresh_token(&r1), 0).await;

    // Middleware разрешает стабильный session_id по исходному JTI.
    let original_jti: String =
        sqlx::query_scalar("SELECT jwt_id FROM flora_core.user_sessions WHERE session_id=$1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let resolved = repo
        .find_active_session_id_by_jwt(user_uuid, &original_jti, Utc::now())
        .await
        .unwrap();
    assert_eq!(resolved, Some(session_id));

    // Конкурентная ротация меняет jwt_id (R1 -> R2), JTI строки больше не original.
    let (grant, _) = prepare(session_id, &r1, 0, &ring);
    assert!(matches!(
        pool_rotate(&pool, session_id, &r1, &grant).await,
        RefreshOutcome::Rotated { .. }
    ));
    let rotated_jti: String =
        sqlx::query_scalar("SELECT jwt_id FROM flora_core.user_sessions WHERE session_id=$1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(rotated_jti, original_jti, "ротация сменила JTI");

    // Logout по стабильному session_id (разрешённому по СТАРОМУ JTI) всё равно
    // отзывает сессию — ротация JTI не может обойти logout.
    let affected = repo.revoke_by_session_id_logout(session_id).await.unwrap();
    assert_eq!(affected, 1, "logout отозвал строку по session_id");
    let status: i32 =
        sqlx::query_scalar("SELECT status FROM flora_core.user_sessions WHERE session_id=$1")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, 4, "сессия отозвана logout'ом несмотря на смену JTI");

    // После logout старый JTI больше не разрешается в активную сессию.
    let after_logout = repo
        .find_active_session_id_by_jwt(user_uuid, &original_jti, Utc::now())
        .await
        .unwrap();
    assert_eq!(after_logout, None);

    cleanup(&pool, session_id).await;
}

async fn pool_rotate(
    pool: &PgPool,
    session_id: Uuid,
    presented: &str,
    grant: &PreparedGrant,
) -> RefreshOutcome {
    pool_rotate_drain(pool, session_id, presented, grant, false).await
}

async fn pool_rotate_drain(
    pool: &PgPool,
    session_id: Uuid,
    presented: &str,
    grant: &PreparedGrant,
    draining: bool,
) -> RefreshOutcome {
    AuthRepo::new(pool.clone())
        .rotate_or_replay(
            session_id,
            presented,
            &hash_refresh_token(presented),
            true,
            grant,
            GRACE,
            draining,
        )
        .await
        .expect("rotate_or_replay")
}
