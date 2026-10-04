//! Fixed-window rate limit — паритет `SocialRateLimitPolicies.Write` / `Upload`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::HeaderMap;

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

pub fn default_upload_limiter() -> Arc<FixedWindowLimiter> {
    Arc::new(FixedWindowLimiter::new(30, Duration::from_secs(10 * 60)))
}

pub fn client_ip_key(headers: &HeaderMap) -> String {
    if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
        && let Some(first) = forwarded.split(',').map(str::trim).find(|s| !s.is_empty())
    {
        return first.to_string();
    }
    "anon".into()
}
