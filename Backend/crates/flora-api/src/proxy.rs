//! Прозрачный реверс-прокси на .NET-хост — gateway-fallback переходного периода (§5.1).
//!
//! Требования Фазы 0: потоковая передача тел в обе стороны (multipart-загрузки, медиа
//! из `bytea`), прозрачный SSE (без буферизации и таймаута простоя), корректное
//! дописывание `X-Forwarded-For`, передача статус-кодов и заголовков как есть.
//! Сквозные middleware проксируемых маршрутов исполняет .NET (§5.1) — прокси нейтрален.

use std::net::SocketAddr;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::response::{IntoResponse, Response};
use http::uri::{Authority, Scheme};
use http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

/// Апстрим .NET-хоста (`Gateway:DotnetUpstream`, например `http://127.0.0.1:5284`).
#[derive(Debug, Clone)]
pub struct DotnetUpstream {
    scheme: Scheme,
    authority: Authority,
}

impl DotnetUpstream {
    pub fn from_config(cfg: &flora_shared::config::FloraConfig) -> Option<Self> {
        Self::parse(cfg.get_non_empty("Gateway:DotnetUpstream")?)
    }

    /// Принимает только `http(s)://host[:port]` без path/query — иначе прокси
    /// не сможет прозрачно сохранять оригинальные пути.
    pub fn parse(raw: &str) -> Option<Self> {
        let uri: Uri = raw.trim().parse().ok()?;
        let scheme = uri.scheme().cloned()?;
        let authority = uri.authority().cloned()?;
        if uri.path() != "/" && !uri.path().is_empty() {
            return None;
        }
        Some(Self { scheme, authority })
    }
}

/// Хоп-бай-хоп заголовки (RFC 9110 §7.6.1) — не пересекают прокси.
const HOP_BY_HOP: [HeaderName; 8] = [
    HeaderName::from_static("connection"),
    HeaderName::from_static("keep-alive"),
    HeaderName::from_static("proxy-authenticate"),
    HeaderName::from_static("proxy-authorization"),
    HeaderName::from_static("proxy-connection"),
    HeaderName::from_static("te"),
    HeaderName::from_static("transfer-encoding"),
    HeaderName::from_static("upgrade"),
];

pub const X_FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");

type ProxyClient = Client<HttpConnector, Body>;

#[derive(Clone)]
struct ProxyState {
    upstream: DotnetUpstream,
    client: ProxyClient,
}

/// Fallback-сервис прокси. Отдельный tower-сервис (а не handler-fn), чтобы axum
/// не применял к нему экстракторы с лимитами тел — стриминг без ограничений размера,
/// лимиты исполняет .NET (паритет).
pub fn proxy_service(upstream: DotnetUpstream) -> axum::routing::MethodRouter {
    let mut connector = HttpConnector::new();
    connector.set_connect_timeout(Some(Duration::from_secs(5)));
    connector.set_nodelay(true);
    // Никаких таймаутов чтения/общего времени: SSE-стримы живут часами,
    // большие загрузки идут столько, сколько нужно (§5.1).
    let client: ProxyClient = Client::builder(TokioExecutor::new())
        .pool_idle_timeout(Duration::from_secs(90))
        .build(connector);

    let state = ProxyState { upstream, client };
    axum::routing::any(move |request: Request<Body>| {
        let state = state.clone();
        // ConnectInfo берём из extensions (into_make_service_with_connect_info),
        // а не экстрактором: в тестах без TCP-подключения его нет — это допустимо.
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0);
        async move { forward(state, peer, request).await }
    })
}

async fn forward(
    state: ProxyState,
    peer: Option<SocketAddr>,
    mut request: Request<Body>,
) -> Response {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/")
        .to_string();

    let upstream_uri = Uri::builder()
        .scheme(state.upstream.scheme.clone())
        .authority(state.upstream.authority.clone())
        .path_and_query(path_and_query)
        .build();
    let upstream_uri = match upstream_uri {
        Ok(uri) => uri,
        Err(error) => {
            tracing::error!(%error, "не удалось собрать URI апстрима");
            return bad_gateway();
        }
    };

    strip_hop_by_hop(request.headers_mut());
    append_forwarded_for(request.headers_mut(), peer);
    *request.uri_mut() = upstream_uri;

    match state.client.request(request).await {
        Ok(response) => {
            let (mut parts, body) = response.into_parts();
            strip_hop_by_hop(&mut parts.headers);
            parts.extensions.insert(crate::access_log::ProxiedToDotnet);
            // Тело апстрима отдаётся стримом — hyper не буферизует, SSE и медиа
            // проходят покадрово.
            Response::from_parts(parts, Body::new(body))
        }
        Err(error) => {
            tracing::error!(%error, "апстрим .NET недоступен");
            bad_gateway()
        }
    }
}

/// Удаляет hop-by-hop заголовки, включая перечисленные в `Connection` (RFC 9110).
fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let listed: Vec<HeaderName> = headers
        .get_all(http::header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|name| name.trim().parse().ok())
        .collect();
    for name in listed {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
}

/// Дописывает адрес непосредственного пира (nginx) в `X-Forwarded-For`;
/// первый hop — реальный клиент — остаётся первым (его читает rate limiter .NET, §4.5).
fn append_forwarded_for(headers: &mut HeaderMap, peer: Option<SocketAddr>) {
    let Some(peer) = peer else { return };
    let peer_ip = peer.ip().to_string();
    let value = match headers.get(&X_FORWARDED_FOR).and_then(|v| v.to_str().ok()) {
        Some(existing) if !existing.trim().is_empty() => format!("{existing}, {peer_ip}"),
        _ => peer_ip,
    };
    if let Ok(header_value) = HeaderValue::from_str(&value) {
        headers.insert(X_FORWARDED_FOR, header_value);
    }
}

fn bad_gateway() -> Response {
    (
        StatusCode::BAD_GATEWAY,
        axum::Json(serde_json::json!({ "error": "upstream unavailable" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_parse_accepts_authority_only() {
        assert!(DotnetUpstream::parse("http://127.0.0.1:5284").is_some());
        assert!(DotnetUpstream::parse("http://127.0.0.1:5284/").is_some());
        assert!(DotnetUpstream::parse("http://127.0.0.1:5284/api").is_none());
        assert!(
            DotnetUpstream::parse("127.0.0.1:5284").is_none(),
            "нужна схема"
        );
        assert!(DotnetUpstream::parse("").is_none());
    }

    #[test]
    fn forwarded_for_appends_peer_after_existing_chain() {
        let mut headers = HeaderMap::new();
        headers.insert(X_FORWARDED_FOR, HeaderValue::from_static("203.0.113.7"));
        append_forwarded_for(&mut headers, Some("127.0.0.1:9999".parse().unwrap()));
        assert_eq!(
            headers.get(X_FORWARDED_FOR).unwrap(),
            "203.0.113.7, 127.0.0.1"
        );
    }

    #[test]
    fn forwarded_for_sets_peer_when_missing() {
        let mut headers = HeaderMap::new();
        append_forwarded_for(&mut headers, Some("10.0.0.2:1234".parse().unwrap()));
        assert_eq!(headers.get(X_FORWARDED_FOR).unwrap(), "10.0.0.2");
    }

    #[test]
    fn hop_by_hop_headers_are_stripped_including_connection_listed() {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONNECTION,
            HeaderValue::from_static("close, x-custom-hop"),
        );
        headers.insert(
            HeaderName::from_static("x-custom-hop"),
            HeaderValue::from_static("1"),
        );
        headers.insert(
            HeaderName::from_static("keep-alive"),
            HeaderValue::from_static("30"),
        );
        headers.insert(http::header::ACCEPT, HeaderValue::from_static("*/*"));
        strip_hop_by_hop(&mut headers);
        assert!(headers.get("x-custom-hop").is_none());
        assert!(headers.get("keep-alive").is_none());
        assert!(headers.get(http::header::CONNECTION).is_none());
        assert_eq!(headers.get(http::header::ACCEPT).unwrap(), "*/*");
    }
}
