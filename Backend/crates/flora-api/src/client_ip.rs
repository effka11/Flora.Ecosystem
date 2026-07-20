//! Нормализация IP клиента на единственной доверенной HTTP-границе.
//!
//! Внутренние Social-модули исторически читают первый `X-Forwarded-For`.
//! Host заменяет входящую цепочку одним проверенным адресом: заголовок учитывается
//! только от непосредственного пира из `Gateway:TrustedProxies`.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderValue, header::FORWARDED};
use axum::middleware::Next;
use axum::response::Response;
use flora_shared::config::FloraConfig;
use ipnet::IpNet;

const X_FORWARDED_FOR: &str = "x-forwarded-for";
const X_REAL_IP: &str = "x-real-ip";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClientIp(pub IpAddr);

#[derive(Clone)]
pub struct ClientIpResolver {
    trusted_proxies: Arc<Vec<IpNet>>,
}

impl ClientIpResolver {
    pub fn from_config(cfg: &FloraConfig) -> Self {
        let configured = cfg.get_string_array("Gateway:TrustedProxies");
        let raw = if configured.is_empty() {
            vec!["127.0.0.0/8".to_string(), "::1/128".to_string()]
        } else {
            configured
        };

        let trusted_proxies = raw
            .into_iter()
            .filter_map(|entry| match entry.trim().parse::<IpNet>() {
                Ok(net) => Some(net),
                Err(error) => {
                    tracing::warn!(
                        proxy = %entry,
                        %error,
                        "Gateway:TrustedProxies содержит невалидный IP/CIDR; запись проигнорирована"
                    );
                    None
                }
            })
            .collect();

        Self {
            trusted_proxies: Arc::new(trusted_proxies),
        }
    }

    fn is_trusted(&self, ip: IpAddr) -> bool {
        self.trusted_proxies.iter().any(|net| net.contains(&ip))
    }

    fn resolve(&self, peer: IpAddr, forwarded_for: Option<&str>) -> IpAddr {
        if !self.is_trusted(peer) {
            return peer;
        }

        forwarded_for
            .into_iter()
            .flat_map(|chain| chain.split(','))
            .rev()
            .filter_map(parse_forwarded_ip)
            .find(|ip| !self.is_trusted(*ip))
            .unwrap_or(peer)
    }
}

/// Удаляет недоверенные forwarding-заголовки и публикует для модулей только
/// проверенный адрес. При отсутствии TCP `ConnectInfo` заголовки удаляются:
/// тестовый/in-process вызов попадает в общий fail-closed bucket `anon`.
pub async fn normalize_client_ip(
    State(resolver): State<ClientIpResolver>,
    mut request: Request,
    next: Next,
) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip());
    let forwarded = request
        .headers()
        .get(X_FORWARDED_FOR)
        .and_then(|value| value.to_str().ok());
    let client_ip = peer.map(|peer| resolver.resolve(peer, forwarded));

    request.headers_mut().remove(X_FORWARDED_FOR);
    request.headers_mut().remove(X_REAL_IP);
    request.headers_mut().remove(FORWARDED);

    if let Some(ip) = client_ip {
        let value = HeaderValue::from_str(&ip.to_string()).expect("IP всегда валиден как header");
        request.headers_mut().insert(X_FORWARDED_FOR, value.clone());
        request.headers_mut().insert(X_REAL_IP, value);
        request.extensions_mut().insert(ClientIp(ip));
    }

    next.run(request).await
}

fn parse_forwarded_ip(value: &str) -> Option<IpAddr> {
    value.trim().trim_matches('"').parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resolver(proxies: &[&str]) -> ClientIpResolver {
        let values: Vec<_> = proxies.iter().map(|value| json!(value)).collect();
        let cfg = FloraConfig::from_layers(
            "Production",
            &[json!({ "Gateway": { "TrustedProxies": values } })],
            &[],
        );
        ClientIpResolver::from_config(&cfg)
    }

    #[test]
    fn untrusted_peer_cannot_spoof_forwarded_header() {
        let resolver = resolver(&["127.0.0.0/8"]);
        let peer = "198.51.100.9".parse().unwrap();
        assert_eq!(
            resolver.resolve(peer, Some("203.0.113.7")),
            "198.51.100.9".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn trusted_proxy_uses_rightmost_untrusted_hop() {
        let resolver = resolver(&["127.0.0.0/8"]);
        let peer = "127.0.0.1".parse().unwrap();
        assert_eq!(
            resolver.resolve(peer, Some("192.0.2.123, 203.0.113.7")),
            "203.0.113.7".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn trusted_proxy_chain_is_walked_from_the_right() {
        let resolver = resolver(&["127.0.0.0/8", "10.0.0.0/8"]);
        let peer = "127.0.0.1".parse().unwrap();
        assert_eq!(
            resolver.resolve(peer, Some("198.51.100.4, 10.20.30.40")),
            "198.51.100.4".parse::<IpAddr>().unwrap()
        );
    }
}
