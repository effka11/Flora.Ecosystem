//! HTTP-слой Economy: тонкие axum-хендлеры `/api/economy/*`.
//!
//! Аутентификация здесь — только транспортная (JWT добавляет хост); **авторизация денег —
//! криптографическая**: перевод действителен подписью Ed25519 владельца, и подделать её
//! HTTP-клиент не может, чей бы токен у него ни был. Поэтому хендлеры не принимают решений —
//! они лишь декодируют hex и передают байты секвенсору.
//!
//! Все суммы — grain (i64), все байтовые поля — hex-строки (см. контракт в FEP.md §11).

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use flora_economy_crypto::EconomyError;
use flora_economy_crypto::amount::Grains;
use flora_economy_crypto::hash::to_hex;

use crate::application::{AppliedEntry, EconomyService, ServiceError};

type Svc = Arc<EconomyService>;

/// Роутер модуля поверх собранного сервиса.
pub fn router(service: Svc) -> Router {
    Router::new()
        .route("/api/economy/parameters", get(get_parameters))
        .route("/api/economy/commons", get(get_commons))
        .route("/api/economy/ledger/head", get(get_head))
        .route("/api/economy/ledger/sth", get(get_sth))
        .route("/api/economy/ledger/cosigns", post(post_cosign))
        .route("/api/economy/ledger/entries", get(get_entries))
        .route("/api/economy/ledger/proof/{seq}", get(get_proof))
        .route("/api/economy/ledger/consistency", get(get_consistency))
        .route("/api/economy/accounts", post(post_account))
        .route("/api/economy/accounts/{id}", get(get_account))
        .route("/api/economy/ubi/claims", post(post_ubi_claim))
        .route("/api/economy/transfers", post(post_transfer))
        .route("/api/economy/trustlines", post(post_trustline))
        .route("/api/economy/credit-transfers", post(post_credit_transfer))
        .with_state(service)
}

// ---------- ошибки ----------

/// Тело ошибки — единый формат `{ "error": { "code", "message" } }`.
#[derive(Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

struct ApiError(StatusCode, &'static str, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.1,
                    message: self.2,
                },
            }),
        )
            .into_response()
    }
}

impl From<ServiceError> for ApiError {
    fn from(e: ServiceError) -> ApiError {
        let (status, code) = match &e {
            ServiceError::Economy(err) => match err {
                EconomyError::AccountNotFound(_) => (StatusCode::NOT_FOUND, "account_not_found"),
                EconomyError::AccountAlreadyExists(_) => (StatusCode::CONFLICT, "account_exists"),
                EconomyError::InsufficientFunds { .. } => {
                    (StatusCode::UNPROCESSABLE_ENTITY, "insufficient_funds")
                }
                EconomyError::TrustlineCapacityExceeded { .. } => (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "trustline_capacity_exceeded",
                ),
                EconomyError::TrustlineNotFound => (StatusCode::NOT_FOUND, "trustline_not_found"),
                EconomyError::UbiAlreadyClaimed => (StatusCode::CONFLICT, "ubi_already_claimed"),
                EconomyError::PersonhoodRequired => (StatusCode::FORBIDDEN, "personhood_required"),
                EconomyError::InvalidSignature | EconomyError::InvalidPublicKey => {
                    (StatusCode::UNAUTHORIZED, "invalid_signature")
                }
                EconomyError::ReplayDiverged { .. } => {
                    (StatusCode::CONFLICT, "sequencing_conflict")
                }
                _ => (StatusCode::BAD_REQUEST, "rejected"),
            },
            ServiceError::Store(_) => (StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"),
            ServiceError::UnknownWitness => (StatusCode::FORBIDDEN, "unknown_witness"),
            ServiceError::CosignMismatch(_) => (StatusCode::CONFLICT, "cosign_mismatch"),
        };
        ApiError(status, code, e.to_string())
    }
}

fn bad_hex() -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        "invalid_hex",
        "поле должно быть hex-строкой ожидаемой длины".into(),
    )
}

fn parse_hex<const N: usize>(s: &str) -> Result<[u8; N], ApiError> {
    if s.len() != N * 2 {
        return Err(bad_hex());
    }
    let mut out = [0u8; N];
    let bytes = s.as_bytes();
    for (i, item) in out.iter_mut().enumerate() {
        let hi = (bytes[i * 2] as char).to_digit(16).ok_or_else(bad_hex)?;
        let lo = (bytes[i * 2 + 1] as char)
            .to_digit(16)
            .ok_or_else(bad_hex)?;
        *item = ((hi as u8) << 4) | lo as u8;
    }
    Ok(out)
}

// ---------- DTO ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedDto {
    seq: u64,
    entry_hash: String,
    at_ms: i64,
}

impl From<AppliedEntry> for AppliedDto {
    fn from(a: AppliedEntry) -> AppliedDto {
        AppliedDto {
            seq: a.seq,
            entry_hash: to_hex(&a.entry_hash),
            at_ms: a.at.0,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenAccountRequest {
    account_uuid: Uuid,
    /// Ed25519-ключ владения, 64 hex-символа.
    owner_key_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UbiClaimRequest {
    account_uuid: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferRequest {
    from_uuid: Uuid,
    to_uuid: Uuid,
    amount_grains: i64,
    nonce_hex: String,
    signature_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustlineRequest {
    lo_uuid: Uuid,
    hi_uuid: Uuid,
    limit_lo_to_hi_grains: i64,
    limit_hi_to_lo_grains: i64,
    signature_lo_hex: String,
    signature_hi_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreditTransferRequest {
    path_uuids: Vec<Uuid>,
    amount_grains: i64,
    nonce_hex: String,
    signature_hex: String,
}

#[derive(Deserialize)]
struct EntriesQuery {
    #[serde(default)]
    from: u64,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    100
}

// ---------- хендлеры ----------

async fn get_parameters(State(svc): State<Svc>) -> impl IntoResponse {
    Json(svc.parameters())
}

async fn get_commons(State(svc): State<Svc>) -> Result<impl IntoResponse, ApiError> {
    use flora_economy_contracts::EconomyReadPort;
    svc.commons_summary().map(Json).map_err(|e| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_unavailable",
            e.to_string(),
        )
    })
}

async fn get_head(State(svc): State<Svc>) -> impl IntoResponse {
    Json(svc.head())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SthDto {
    /// Текущий head журнала.
    head: flora_economy_crypto::ledger::LedgerHead,
    /// Реестр витнессов (hex-ключи Ed25519).
    witnesses: Vec<String>,
    /// Самый свежий валидный косайн каждого витнесса. Косайн может относиться к более
    /// раннему head — связь с текущим проверяется consistency-доказательством.
    cosigns: Vec<flora_economy_crypto::witness::HeadCosign>,
}

async fn get_sth(State(svc): State<Svc>) -> impl IntoResponse {
    let (head, cosigns, witnesses) = svc.sth();
    Json(SthDto {
        head,
        witnesses: witnesses.iter().map(to_hex).collect(),
        cosigns,
    })
}

async fn post_cosign(
    State(svc): State<Svc>,
    Json(cosign): Json<flora_economy_crypto::witness::HeadCosign>,
) -> Result<impl IntoResponse, ApiError> {
    let size = cosign.head.size;
    svc.submit_cosign(cosign)?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "accepted": true, "size": size })),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsistencyQuery {
    old_size: u64,
    new_size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsistencyDto {
    old_size: u64,
    new_size: u64,
    old_root: String,
    new_root: String,
    proof: Vec<String>,
    head: flora_economy_crypto::ledger::LedgerHead,
}

async fn get_consistency(
    State(svc): State<Svc>,
    Query(q): Query<ConsistencyQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let slice = svc.consistency(q.old_size, q.new_size).ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_range",
            "требуется 1 <= oldSize <= newSize <= размер журнала".into(),
        )
    })?;
    Ok(Json(ConsistencyDto {
        old_size: slice.old_size,
        new_size: slice.new_size,
        old_root: to_hex(&slice.old_root),
        new_root: to_hex(&slice.new_root),
        proof: slice.proof.iter().map(to_hex).collect(),
        head: slice.head,
    }))
}

async fn get_entries(
    State(svc): State<Svc>,
    Query(q): Query<EntriesQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(svc.entries(q.from, q.limit)?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofDto {
    seq: u64,
    proof: Vec<String>,
    head: flora_economy_crypto::ledger::LedgerHead,
}

async fn get_proof(
    State(svc): State<Svc>,
    Path(seq): Path<u64>,
) -> Result<impl IntoResponse, ApiError> {
    let (proof, head) = svc.inclusion_proof(seq).ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            "entry_not_found",
            format!("запись {seq} вне журнала"),
        )
    })?;
    Ok(Json(ProofDto {
        seq,
        proof: proof.iter().map(to_hex).collect(),
        head,
    }))
}

async fn post_account(
    State(svc): State<Svc>,
    Json(req): Json<OpenAccountRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let owner_key: [u8; 32] = parse_hex(&req.owner_key_hex)?;
    let summary = svc.open_account(req.account_uuid, owner_key)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

async fn get_account(
    State(svc): State<Svc>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    use flora_economy_contracts::EconomyReadPort;
    svc.account_summary(id).map(Json).map_err(|e| match e {
        flora_economy_contracts::EconomyPortError::AccountNotFound => ApiError(
            StatusCode::NOT_FOUND,
            "account_not_found",
            "экономический аккаунт не найден".into(),
        ),
        other => ApiError(StatusCode::BAD_REQUEST, "rejected", other.to_string()),
    })
}

async fn post_ubi_claim(
    State(svc): State<Svc>,
    Json(req): Json<UbiClaimRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let applied = svc.claim_ubi(req.account_uuid)?;
    Ok((StatusCode::CREATED, Json(AppliedDto::from(applied))))
}

async fn post_transfer(
    State(svc): State<Svc>,
    Json(req): Json<TransferRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let nonce: [u8; 16] = parse_hex(&req.nonce_hex)?;
    let signature: [u8; 64] = parse_hex(&req.signature_hex)?;
    let applied = svc.transfer(
        req.from_uuid,
        req.to_uuid,
        Grains(req.amount_grains),
        nonce,
        signature,
    )?;
    Ok((StatusCode::CREATED, Json(AppliedDto::from(applied))))
}

async fn post_trustline(
    State(svc): State<Svc>,
    Json(req): Json<TrustlineRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let signature_lo: [u8; 64] = parse_hex(&req.signature_lo_hex)?;
    let signature_hi: [u8; 64] = parse_hex(&req.signature_hi_hex)?;
    let applied = svc.set_trustline(
        req.lo_uuid,
        req.hi_uuid,
        Grains(req.limit_lo_to_hi_grains),
        Grains(req.limit_hi_to_lo_grains),
        signature_lo,
        signature_hi,
    )?;
    Ok((StatusCode::CREATED, Json(AppliedDto::from(applied))))
}

async fn post_credit_transfer(
    State(svc): State<Svc>,
    Json(req): Json<CreditTransferRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let nonce: [u8; 16] = parse_hex(&req.nonce_hex)?;
    let signature: [u8; 64] = parse_hex(&req.signature_hex)?;
    let applied =
        svc.credit_transfer(req.path_uuids, Grains(req.amount_grains), nonce, signature)?;
    Ok((StatusCode::CREATED, Json(AppliedDto::from(applied))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::{FixedLevelAttestor, InMemoryCosignStore, InMemoryLedgerStore};
    use flora_economy_crypto::domain as tags;
    use flora_economy_crypto::ledger::transfer_signing_bytes;
    use flora_economy_crypto::sig::{public_key, sign};
    use flora_verification_contracts::PersonhoodLevel;
    use http_body_util::BodyExt;
    use tower::util::ServiceExt;

    const ALICE_SEED: [u8; 32] = [11u8; 32];
    const BOB_SEED: [u8; 32] = [22u8; 32];
    const WITNESS_SEED: [u8; 32] = [77u8; 32];

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn app(level: PersonhoodLevel) -> Router {
        let module = crate::compose(
            Arc::new(InMemoryLedgerStore::new()),
            Arc::new(InMemoryCosignStore::new()),
            vec![public_key(&WITNESS_SEED)],
            Arc::new(FixedLevelAttestor(level)),
        )
        .unwrap();
        module.router
    }

    async fn send_json(
        router: &Router,
        method: &str,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let builder = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        let request = builder
            .body(match body {
                Some(v) => axum::body::Body::from(v.to_string()),
                None => axum::body::Body::empty(),
            })
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, json)
    }

    #[tokio::test]
    async fn full_http_flow() {
        let router = app(PersonhoodLevel::V1);
        let alice = Uuid::from_u128(1);
        let bob = Uuid::from_u128(2);

        // Параметры и head доступны сразу (genesis записан при compose).
        let (status, head) = send_json(&router, "GET", "/api/economy/ledger/head", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(head["size"], 1);

        // Открываем два аккаунта.
        for (id, seed) in [(alice, &ALICE_SEED), (bob, &BOB_SEED)] {
            let (status, _) = send_json(
                &router,
                "POST",
                "/api/economy/accounts",
                Some(serde_json::json!({
                    "accountUuid": id,
                    "ownerKeyHex": hex(&public_key(seed)),
                })),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED);
        }

        // UBI Алисе.
        let (status, _) = send_json(
            &router,
            "POST",
            "/api/economy/ubi/claims",
            Some(serde_json::json!({ "accountUuid": alice })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);

        // Подписанный перевод Алиса → Боб.
        let amount = 250_000_000i64; // 250 liv
        let nonce = [7u8; 16];
        let payload = transfer_signing_bytes(
            &crate::domain::account_id_of(alice),
            &crate::domain::account_id_of(bob),
            Grains(amount),
            &nonce,
        );
        let signature = sign(tags::TRANSFER_AUTH, &payload, &ALICE_SEED);
        let (status, _) = send_json(
            &router,
            "POST",
            "/api/economy/transfers",
            Some(serde_json::json!({
                "fromUuid": alice,
                "toUuid": bob,
                "amountGrains": amount,
                "nonceHex": hex(&nonce),
                "signatureHex": hex(&signature),
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);

        // Баланс Боба виден по GET.
        let (status, account) = send_json(
            &router,
            "GET",
            &format!("/api/economy/accounts/{bob}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(account["balanceGrains"], amount);

        // Журнал отдаётся страницами, и по нему можно получить proof.
        let (status, entries) = send_json(
            &router,
            "GET",
            "/api/economy/ledger/entries?from=0&limit=10",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(entries.as_array().unwrap().len(), 5);
        let (status, proof) = send_json(&router, "GET", "/api/economy/ledger/proof/2", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!proof["proof"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn witness_protocol_over_http() {
        let router = app(PersonhoodLevel::V1);
        let alice = Uuid::from_u128(1);

        // Появляется хоть какая-то история: аккаунт + UBI.
        send_json(
            &router,
            "POST",
            "/api/economy/accounts",
            Some(serde_json::json!({
                "accountUuid": alice,
                "ownerKeyHex": hex(&public_key(&ALICE_SEED)),
            })),
        )
        .await;
        send_json(
            &router,
            "POST",
            "/api/economy/ubi/claims",
            Some(serde_json::json!({ "accountUuid": alice })),
        )
        .await;

        // STH: head + реестр витнессов, косайнов пока нет.
        let (status, sth) = send_json(&router, "GET", "/api/economy/ledger/sth", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(sth["witnesses"].as_array().unwrap().len(), 1);
        assert!(sth["cosigns"].as_array().unwrap().is_empty());

        // Витнесс подписывает увиденный head и отправляет косайн.
        let head: flora_economy_crypto::ledger::LedgerHead =
            serde_json::from_value(sth["head"].clone()).unwrap();
        let cosign = flora_economy_crypto::witness::cosign_head(&head, &WITNESS_SEED);
        let (status, body) = send_json(
            &router,
            "POST",
            "/api/economy/ledger/cosigns",
            Some(serde_json::to_value(&cosign).unwrap()),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["accepted"], true);

        // Косайн виден в STH.
        let (_, sth) = send_json(&router, "GET", "/api/economy/ledger/sth", None).await;
        assert_eq!(sth["cosigns"].as_array().unwrap().len(), 1);

        // Косайн чужого журнала отклоняется с 409.
        let mut forged = head.clone();
        forged.merkle_root = [0xAB; 32];
        let bad = flora_economy_crypto::witness::cosign_head(&forged, &WITNESS_SEED);
        let (status, body) = send_json(
            &router,
            "POST",
            "/api/economy/ledger/cosigns",
            Some(serde_json::to_value(&bad).unwrap()),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"]["code"], "cosign_mismatch");

        // Неизвестный витнесс — 403.
        let stranger = flora_economy_crypto::witness::cosign_head(&head, &[99u8; 32]);
        let (status, body) = send_json(
            &router,
            "POST",
            "/api/economy/ledger/cosigns",
            Some(serde_json::to_value(&stranger).unwrap()),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["code"], "unknown_witness");

        // Consistency-доказательство от размера 1 до текущего проверяется ядром.
        let old_size = 1u64;
        let new_size = head.size;
        let (status, dto) = send_json(
            &router,
            "GET",
            &format!("/api/economy/ledger/consistency?oldSize={old_size}&newSize={new_size}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let parse_root = |v: &serde_json::Value| -> [u8; 32] {
            let s = v.as_str().unwrap();
            let mut out = [0u8; 32];
            for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
                out[i] = u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16).unwrap();
            }
            out
        };
        let proof: Vec<[u8; 32]> = dto["proof"]
            .as_array()
            .unwrap()
            .iter()
            .map(parse_root)
            .collect();
        assert!(flora_economy_crypto::merkle::verify_consistency(
            old_size,
            new_size,
            &parse_root(&dto["oldRoot"]),
            &parse_root(&dto["newRoot"]),
            &proof,
        ));

        // Некорректный диапазон — 400.
        let (status, _) = send_json(
            &router,
            "GET",
            "/api/economy/ledger/consistency?oldSize=0",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn ubi_denied_without_personhood() {
        let router = app(PersonhoodLevel::V0);
        let alice = Uuid::from_u128(1);
        send_json(
            &router,
            "POST",
            "/api/economy/accounts",
            Some(serde_json::json!({
                "accountUuid": alice,
                "ownerKeyHex": hex(&public_key(&ALICE_SEED)),
            })),
        )
        .await;
        let (status, body) = send_json(
            &router,
            "POST",
            "/api/economy/ubi/claims",
            Some(serde_json::json!({ "accountUuid": alice })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["code"], "personhood_required");
    }

    #[tokio::test]
    async fn transfer_with_wrong_signature_is_unauthorized() {
        let router = app(PersonhoodLevel::V1);
        let alice = Uuid::from_u128(1);
        let bob = Uuid::from_u128(2);
        for (id, seed) in [(alice, &ALICE_SEED), (bob, &BOB_SEED)] {
            send_json(
                &router,
                "POST",
                "/api/economy/accounts",
                Some(serde_json::json!({
                    "accountUuid": id,
                    "ownerKeyHex": hex(&public_key(seed)),
                })),
            )
            .await;
        }
        send_json(
            &router,
            "POST",
            "/api/economy/ubi/claims",
            Some(serde_json::json!({ "accountUuid": alice })),
        )
        .await;
        // Подпись ключом Боба вместо Алисы.
        let (status, body) = send_json(
            &router,
            "POST",
            "/api/economy/transfers",
            Some(serde_json::json!({
                "fromUuid": alice,
                "toUuid": bob,
                "amountGrains": 1,
                "nonceHex": hex(&[1u8; 16]),
                "signatureHex": hex(&[0u8; 64]),
            })),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["code"], "invalid_signature");
    }

    #[tokio::test]
    async fn malformed_hex_is_bad_request() {
        let router = app(PersonhoodLevel::V1);
        let (status, body) = send_json(
            &router,
            "POST",
            "/api/economy/accounts",
            Some(serde_json::json!({
                "accountUuid": Uuid::from_u128(1),
                "ownerKeyHex": "zz",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid_hex");
    }
}
