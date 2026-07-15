//! Fixed-window rate limit — паритет `SocialRateLimitPolicies` (не GCRA).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

pub struct FixedWindowLimiter {
    permit_limit: u32,
    window: Duration,
    buckets: Mutex<HashMap<String, (Instant, u32)>>,
}

impl FixedWindowLimiter {
    pub fn new(permit_limit: u32, window: Duration) -> Self {
        Self {
            permit_limit,
            window,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// `true` если запрос разрешён.
    pub fn check_and_increment(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut map = self.buckets.lock().expect("rate limiter lock");
        map.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        let entry = map.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        if entry.1 >= self.permit_limit {
            return false;
        }
        entry.1 += 1;
        true
    }
}

#[derive(Clone)]
pub struct AnonymousAuthLimiters {
    pub login: Arc<FixedWindowLimiter>,
    pub refresh: Arc<FixedWindowLimiter>,
    pub register: Arc<FixedWindowLimiter>,
    pub verify: Arc<FixedWindowLimiter>,
}

impl AnonymousAuthLimiters {
    pub fn social_defaults() -> Self {
        Self {
            login: Arc::new(FixedWindowLimiter::new(10, Duration::from_secs(5 * 60))),
            refresh: Arc::new(FixedWindowLimiter::new(60, Duration::from_secs(5 * 60))),
            register: Arc::new(FixedWindowLimiter::new(8, Duration::from_secs(15 * 60))),
            verify: Arc::new(FixedWindowLimiter::new(12, Duration::from_secs(15 * 60))),
        }
    }
}

/// Первый hop `X-Forwarded-For`, иначе `anon`.
pub fn client_ip_key(req: &Request) -> String {
    if let Some(forwarded) = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
    {
        if let Some(first) = forwarded.split(',').map(str::trim).find(|s| !s.is_empty()) {
            return first.to_string();
        }
    }
    "anon".into()
}

pub async fn anonymous_auth_rate_limit(
    axum::extract::State(limiters): axum::extract::State<AnonymousAuthLimiters>,
    req: Request,
    next: Next,
) -> Response {
    let key = client_ip_key(&req);
    let path = req.uri().path();
    let allowed = match path {
        "/api/auth/login" => limiters.login.check_and_increment(&key),
        "/api/auth/refresh" => limiters.refresh.check_and_increment(&key),
        "/api/auth/register" | "/api/auth/cancel-registration" => {
            limiters.register.check_and_increment(&key)
        }
        "/api/auth/verify-registration" => limiters.verify.check_and_increment(&key),
        _ => true,
    };
    if !allowed {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    next.run(req).await
}

/// `social-account-sensitive`: 10 / 15 мин, ключ = JWT sub (иначе IP).
pub fn account_sensitive_limiter() -> Arc<FixedWindowLimiter> {
    Arc::new(FixedWindowLimiter::new(10, Duration::from_secs(15 * 60)))
}

pub async fn account_sensitive_rate_limit(
    axum::extract::State(limiter): axum::extract::State<Arc<FixedWindowLimiter>>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path();
    let is_sensitive = matches!(
        path,
        "/api/auth/me/password"
            | "/api/auth/delete-account"
            | "/api/auth/me/email/change"
            | "/api/auth/me/email/confirm"
            | "/api/auth/me/phone"
            | "/api/auth/me/2fa/setup"
            | "/api/auth/me/2fa/enable"
            | "/api/auth/me/2fa"
    );
    if !is_sensitive {
        return next.run(req).await;
    }
    let key = req
        .extensions()
        .get::<super::AuthUser>()
        .map(|u| u.user_uuid.to_string())
        .unwrap_or_else(|| client_ip_key(&req));
    if !limiter.check_and_increment(&key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_limit_then_blocks() {
        let lim = FixedWindowLimiter::new(3, Duration::from_secs(60));
        assert!(lim.check_and_increment("a"));
        assert!(lim.check_and_increment("a"));
        assert!(lim.check_and_increment("a"));
        assert!(!lim.check_and_increment("a"));
        assert!(lim.check_and_increment("b"));
    }
}
