//! Проверка минимальной версии мобильного клиента — порт `FloraClientVersionMiddleware.cs`.
//!
//! `X-Flora-Client: {platform}/{version}` → при версии ниже `FloraMobile:MinClientVersion`
//! ответ 426 с телом `{ error, minClientVersion }` (§4.7). Неразборчивые значения
//! пропускаются без блокировки — как в эталоне.

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;

pub const CLIENT_HEADER: &str = "X-Flora-Client";
pub const UPGRADE_MESSAGE: &str = "Требуется обновление приложения.";

#[derive(Debug, Clone, Default)]
pub struct MinClientVersion(pub Option<String>);

impl MinClientVersion {
    pub fn from_config(cfg: &flora_shared::config::FloraConfig) -> Self {
        Self(
            cfg.get_non_empty("FloraMobile:MinClientVersion")
                .map(str::to_string),
        )
    }
}

pub async fn enforce_min_client_version(
    State(min): State<MinClientVersion>,
    request: http::Request<Body>,
    next: Next,
) -> Response {
    let Some(min_raw) = min.0.as_deref() else {
        return next.run(request).await;
    };

    // Несколько значений заголовка .NET склеивает через запятую (StringValues.ToString).
    let header = request
        .headers()
        .get_all(CLIENT_HEADER)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect::<Vec<_>>()
        .join(",");

    if let Some(client_raw) = extract_client_version(&header)
        && let (Some(client), Some(min_version)) = (
            DotnetVersion::parse(client_raw),
            DotnetVersion::parse(min_raw),
        )
        && client < min_version
    {
        return (
            http::StatusCode::UPGRADE_REQUIRED,
            Json(json!({
                "error": UPGRADE_MESSAGE,
                "minClientVersion": min_raw,
            })),
        )
            .into_response();
    }

    next.run(request).await
}

/// Версия из `{platform}/{version}`: часть после первого '/', обрезанная по '+'.
fn extract_client_version(header: &str) -> Option<&str> {
    if header.trim().is_empty() || !header.contains('/') {
        return None;
    }
    let after_slash = &header[header.find('/')? + 1..];
    let version = after_slash.split('+').next().unwrap_or("");
    (!version.trim().is_empty()).then_some(version)
}

/// Семантика `System.Version`: 2–4 числовых компонента, отсутствующие сравниваются как -1
/// (то есть "1.0" < "1.0.0").
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct DotnetVersion {
    major: i64,
    minor: i64,
    build: i64,
    revision: i64,
}

impl DotnetVersion {
    pub fn parse(raw: &str) -> Option<Self> {
        let parts: Vec<&str> = raw.trim().split('.').collect();
        if !(2..=4).contains(&parts.len()) {
            return None;
        }
        let mut numbers = [-1i64; 4];
        for (slot, part) in numbers.iter_mut().zip(&parts) {
            let value: i64 = part.parse().ok()?;
            if value < 0 {
                return None;
            }
            *slot = value;
        }
        Some(Self {
            major: numbers[0],
            minor: numbers[1],
            build: numbers[2],
            revision: numbers[3],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::routing::get;
    use tower::util::ServiceExt;

    fn app(min: Option<&str>) -> Router {
        Router::new().route("/", get(|| async { "ok" })).layer(
            axum::middleware::from_fn_with_state(
                MinClientVersion(min.map(str::to_string)),
                enforce_min_client_version,
            ),
        )
    }

    async fn status_for(app: Router, header: Option<&str>) -> http::StatusCode {
        let mut builder = http::Request::builder().uri("/");
        if let Some(h) = header {
            builder = builder.header(CLIENT_HEADER, h);
        }
        app.oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn outdated_client_gets_426_with_contract_body() {
        let response = app(Some("1.2.0"))
            .oneshot(
                http::Request::builder()
                    .uri("/")
                    .header(CLIENT_HEADER, "android/1.1.9")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::UPGRADE_REQUIRED);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], UPGRADE_MESSAGE);
        assert_eq!(body["minClientVersion"], "1.2.0");
    }

    #[tokio::test]
    async fn passthrough_cases_match_reference() {
        // Выключено конфигом.
        assert_eq!(
            status_for(app(None), Some("android/0.0.1")).await,
            http::StatusCode::OK
        );
        // Нет заголовка / нет слэша / мусорная версия / build-метка после '+'.
        assert_eq!(
            status_for(app(Some("1.2.0")), None).await,
            http::StatusCode::OK
        );
        assert_eq!(
            status_for(app(Some("1.2.0")), Some("android")).await,
            http::StatusCode::OK
        );
        assert_eq!(
            status_for(app(Some("1.2.0")), Some("android/abc")).await,
            http::StatusCode::OK
        );
        assert_eq!(
            status_for(app(Some("1.2.0")), Some("android/1.2.0+45")).await,
            http::StatusCode::OK,
        );
        // Равная и большая версии проходят.
        assert_eq!(
            status_for(app(Some("1.2.0")), Some("ios/1.2.0")).await,
            http::StatusCode::OK,
        );
        assert_eq!(
            status_for(app(Some("1.2.0")), Some("ios/2.0.0")).await,
            http::StatusCode::OK,
        );
    }

    #[test]
    fn version_parse_matches_system_version_semantics() {
        assert!(
            DotnetVersion::parse("1").is_none(),
            "System.Version требует ≥2 компонентов"
        );
        assert!(DotnetVersion::parse("1.0.0.0.0").is_none());
        assert!(DotnetVersion::parse("1.a").is_none());
        assert!(DotnetVersion::parse("-1.0").is_none());
        // "1.0" < "1.0.0" — отсутствующий компонент = -1.
        assert!(DotnetVersion::parse("1.0").unwrap() < DotnetVersion::parse("1.0.0").unwrap());
        assert!(DotnetVersion::parse("1.10").unwrap() > DotnetVersion::parse("1.9").unwrap());
    }
}
