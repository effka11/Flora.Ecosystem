//! Чистая state-machine retry-safe refresh (plan §2) — без БД и без crypto.
//!
//! Решение зависит только от снимка сессии, одной replay-строки, hash поданного
//! токена, признака криптографической привязки к family и текущего времени.
//! `repo.rs` выполняет ту же логику под row lock (single source of truth —
//! функция [`decide`]).
//!
//! Grace-барьер: после ротации R1→R2 на fixed `G=60s` сессия «замирает» на R2.
//! Внутри окна повтор R1 и повтор текущего R2 отдают ровно R2 (никакой R3).
//! После окна текущий R2 может стать R3, а старый R1 считается reuse.

use chrono::{DateTime, Duration, Utc};

/// Fixed grace window. Публичный контракт клиента (см. отчёт субагента).
pub const REFRESH_GRACE_SECONDS: i64 = 60;

/// Grace как `chrono::Duration`.
pub fn refresh_grace() -> Duration {
    Duration::seconds(REFRESH_GRACE_SECONDS)
}

/// Снимок строки `user_sessions` под row lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionState {
    pub active: bool,
    pub expires_at: DateTime<Utc>,
    /// Текущий сохранённый refresh hash (`sha256:...` либо legacy raw).
    pub stored_hash: String,
    pub rotation_id: i64,
}

/// Снимок одной replay-строки на `session_id` (если есть).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayRecord {
    pub spent_hash: String,
    pub replacement_hash: String,
    pub valid_until: DateTime<Utc>,
}

/// Чистое решение по одному refresh-запросу.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshDecision {
    /// Поданный токен — текущий, барьер не активен → ротация вперёд (R1→R2 / R2→R3).
    Rotate,
    /// Вернуть ровно сохранённый R2 (повтор R1 в grace ИЛИ барьер текущего R2 в grace).
    Replay,
    /// Токен принадлежал family, но окно истекло → reuse: отозвать сессию, 401.
    ReuseOutsideGrace,
    /// Нет валидной сессии или legacy-токен без крипто-привязки → 401 без отзыва.
    Invalid,
}

/// Единая логика решения.
///
/// - `presented_is_current` — поданный токен совпадает с текущим сохранённым
///   (учитывает legacy raw: сравнение делает вызывающий, т.к. legacy-строка хранит
///   не `sha256:`-hash, а сырой токен).
/// - `presented_hash` — канонический hash поданного токена (для сверки со
///   spent/replacement hash replay-строки, которые всегда hashed).
/// - `bound` — токен подписан HMAC family (крипто-привязан).
pub fn decide(
    session: Option<&SessionState>,
    replay: Option<&ReplayRecord>,
    presented_hash: &str,
    presented_is_current: bool,
    bound: bool,
    now: DateTime<Utc>,
) -> RefreshDecision {
    let Some(session) = session else {
        return RefreshDecision::Invalid;
    };
    // Сессия отозвана (logout/revoke-others/password) или истекла — replay не
    // воскрешает её. Logout всегда выигрывает.
    if !session.active || session.expires_at <= now {
        return RefreshDecision::Invalid;
    }

    // Строго `>`: на точной границе (valid_until == now) grant уже истёк.
    let fresh = replay.filter(|record| record.valid_until > now);

    if presented_is_current {
        // Текущий токен. Если это R2 внутри его же grace — барьер (без ротации).
        if let Some(record) = fresh
            && record.replacement_hash == presented_hash
        {
            return RefreshDecision::Replay;
        }
        return RefreshDecision::Rotate;
    }

    // Не текущий токен: возможен повтор потраченного R1 внутри grace.
    if let Some(record) = fresh
        && record.spent_hash == presented_hash
    {
        return RefreshDecision::Replay;
    }

    // Устаревший/чужой токен. Крипто-привязанный к family → reuse (отзыв);
    // legacy без привязки → просто 401 без ложного отзыва чужой сессии.
    if bound {
        RefreshDecision::ReuseOutsideGrace
    } else {
        RefreshDecision::Invalid
    }
}

/// Drain-барьер (rollback, plan §3 / runbook «Auth drain rollback»).
///
/// Когда инстанс дренируется, любое решение, которое создало бы НОВУЮ ротацию
/// (`Rotate`) или отозвало бы family по reuse (`ReuseOutsideGrace`), блокируется
/// и превращается в retryable 503 БЕЗ мутации строки. `Replay` (точный
/// сохранённый R2 в grace) и `Invalid` (401) продолжают обслуживаться как есть —
/// drain никогда не приводит к ложному revoke. Logout/revoke-others/password —
/// отдельные эндпоинты и остаются authoritative.
pub fn drain_blocks(decision: RefreshDecision, draining: bool) -> bool {
    draining
        && matches!(
            decision,
            RefreshDecision::Rotate | RefreshDecision::ReuseOutsideGrace
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_blocks_only_mutating_decisions() {
        // В drain: ротация и reuse-revoke блокируются (→ 503, без мутации).
        assert!(drain_blocks(RefreshDecision::Rotate, true));
        assert!(drain_blocks(RefreshDecision::ReuseOutsideGrace, true));
        // Replay (точный R2 в grace) и Invalid (401) продолжают обслуживаться.
        assert!(!drain_blocks(RefreshDecision::Replay, true));
        assert!(!drain_blocks(RefreshDecision::Invalid, true));
        // Без drain ничего не блокируется.
        assert!(!drain_blocks(RefreshDecision::Rotate, false));
        assert!(!drain_blocks(RefreshDecision::ReuseOutsideGrace, false));
        assert!(!drain_blocks(RefreshDecision::Replay, false));
        assert!(!drain_blocks(RefreshDecision::Invalid, false));
    }

    /// Мини-fake refresh-store: моделирует сериализованные под row lock транзакции.
    /// Каждый `step` применяет одно решение, как это делает реальный commit.
    struct FakeStore {
        session: Option<SessionState>,
        replay: Option<ReplayRecord>,
        /// Счётчик выданных токенов, чтобы hash'и были различимы: "r{n}".
        issued: u64,
    }

    impl FakeStore {
        fn new(now: DateTime<Utc>) -> Self {
            // Первый текущий токен — "r0" (stored_hash), rotation 0.
            Self {
                session: Some(SessionState {
                    active: true,
                    expires_at: now + Duration::days(7),
                    stored_hash: "r0".into(),
                    rotation_id: 0,
                }),
                replay: None,
                issued: 0,
            }
        }

        /// Один refresh: принимает hash поданного токена, возвращает решение и,
        /// при Rotate, hash нового текущего токена (R2/R3).
        fn step(
            &mut self,
            presented: &str,
            bound: bool,
            now: DateTime<Utc>,
        ) -> (RefreshDecision, Option<String>) {
            let presented_is_current = self
                .session
                .as_ref()
                .is_some_and(|session| session.stored_hash == presented);
            let decision = decide(
                self.session.as_ref(),
                self.replay.as_ref(),
                presented,
                presented_is_current,
                bound,
                now,
            );
            match decision {
                RefreshDecision::Rotate => {
                    self.issued += 1;
                    let next = format!("r{}", self.issued);
                    let session = self.session.as_mut().unwrap();
                    session.rotation_id += 1;
                    session.stored_hash = next.clone();
                    self.replay = Some(ReplayRecord {
                        spent_hash: presented.to_string(),
                        replacement_hash: next.clone(),
                        valid_until: now + refresh_grace(),
                    });
                    (decision, Some(next))
                }
                RefreshDecision::ReuseOutsideGrace => {
                    if let Some(session) = self.session.as_mut() {
                        session.active = false;
                    }
                    (decision, None)
                }
                RefreshDecision::Replay | RefreshDecision::Invalid => (decision, None),
            }
        }
    }

    fn t0() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-07-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn n_concurrent_r1_first_rotates_rest_replay_same_r2() {
        let now = t0();
        let mut store = FakeStore::new(now);
        // 4 конкурентных R1 (одинаковый токен "r0"), сериализованы row lock'ом.
        let (first, r2) = store.step("r0", true, now);
        assert_eq!(first, RefreshDecision::Rotate);
        let r2 = r2.unwrap();
        for _ in 0..3 {
            let (again, none) = store.step("r0", true, now);
            assert_eq!(
                again,
                RefreshDecision::Replay,
                "повтор R1 в grace → replay R2"
            );
            assert!(none.is_none());
        }
        // Барьер: сам R2 внутри grace тоже возвращает R2, не крутит R3.
        let (barrier, none) = store.step(&r2, true, now);
        assert_eq!(barrier, RefreshDecision::Replay);
        assert!(none.is_none());
    }

    #[test]
    fn lost_response_retry_of_r1_replays_r2() {
        let now = t0();
        let mut store = FakeStore::new(now);
        let (_, r2) = store.step("r0", true, now);
        let r2 = r2.unwrap();
        // Клиент не получил ответ и повторяет R1 через 10s (в пределах grace).
        let later = now + Duration::seconds(10);
        let (decision, _) = store.step("r0", true, later);
        assert_eq!(decision, RefreshDecision::Replay);
        // R2 всё ещё «текущий», барьер держит его.
        assert_eq!(store.session.as_ref().unwrap().stored_hash, r2);
    }

    #[test]
    fn r2_after_grace_rotates_to_r3() {
        let now = t0();
        let mut store = FakeStore::new(now);
        let (_, r2) = store.step("r0", true, now);
        let r2 = r2.unwrap();
        let after = now + Duration::seconds(REFRESH_GRACE_SECONDS + 1);
        let (decision, r3) = store.step(&r2, true, after);
        assert_eq!(decision, RefreshDecision::Rotate);
        assert_ne!(r3.unwrap(), r2);
    }

    #[test]
    fn exact_grace_boundary_is_expired() {
        let now = t0();
        let mut store = FakeStore::new(now);
        store.step("r0", true, now);
        // Ровно на границе valid_until == now → grant истёк.
        let boundary = now + refresh_grace();
        // Повтор R1 на границе: окно закрыто, токен привязан → reuse.
        let (decision, _) = store.step("r0", true, boundary);
        assert_eq!(decision, RefreshDecision::ReuseOutsideGrace);
        // На 1нс раньше границы — ещё replay.
        let mut store2 = FakeStore::new(now);
        store2.step("r0", true, now);
        let just_before = now + refresh_grace() - Duration::nanoseconds(1);
        assert_eq!(
            store2.step("r0", true, just_before).0,
            RefreshDecision::Replay
        );
    }

    #[test]
    fn final_reuse_after_grace_revokes_session() {
        let now = t0();
        let mut store = FakeStore::new(now);
        store.step("r0", true, now); // R1 -> R2
        let after = now + Duration::seconds(REFRESH_GRACE_SECONDS + 5);
        let (decision, _) = store.step("r0", true, after);
        assert_eq!(decision, RefreshDecision::ReuseOutsideGrace);
        assert!(!store.session.as_ref().unwrap().active, "сессия отозвана");
        // После отзыва даже валидный текущий токен невалиден (logout-подобно).
        let (post, _) = store.step("r1", true, after);
        assert_eq!(post, RefreshDecision::Invalid);
    }

    #[test]
    fn logout_during_grace_beats_replay() {
        let now = t0();
        let mut store = FakeStore::new(now);
        store.step("r0", true, now); // R1 -> R2, grace открыт
        // Logout отзывает сессию (session_id-coupled).
        store.session.as_mut().unwrap().active = false;
        // Повтор R1 в пределах grace больше не воскрешает сессию.
        let (decision, _) = store.step("r0", true, now + Duration::seconds(5));
        assert_eq!(decision, RefreshDecision::Invalid);
    }

    #[test]
    fn drain_blocks_new_rotation_but_serves_replay_in_grace() {
        let now = t0();
        let mut store = FakeStore::new(now);
        // R1 -> R2 (обычная ротация до входа в drain).
        let (first, r2) = store.step("r0", true, now);
        assert_eq!(first, RefreshDecision::Rotate);
        let r2 = r2.unwrap();

        // Инстанс дренируется. Повтор R1 в grace: решение Replay → drain НЕ
        // блокирует, точный R2 всё ещё обслуживается.
        let repeat = decide(
            store.session.as_ref(),
            store.replay.as_ref(),
            "r0",
            false,
            true,
            now + Duration::seconds(5),
        );
        assert_eq!(repeat, RefreshDecision::Replay);
        assert!(!drain_blocks(repeat, true), "replay в grace обслуживается");

        // Текущий R2 после grace потребовал бы новую ротацию (R3) → в drain 503.
        let after = now + Duration::seconds(REFRESH_GRACE_SECONDS + 1);
        let would_rotate = decide(
            store.session.as_ref(),
            store.replay.as_ref(),
            &r2,
            true,
            true,
            after,
        );
        assert_eq!(would_rotate, RefreshDecision::Rotate);
        assert!(
            drain_blocks(would_rotate, true),
            "новая ротация в drain → 503"
        );
    }

    #[test]
    fn legacy_unbound_stale_token_is_invalid_not_reuse() {
        let now = t0();
        let mut store = FakeStore::new(now);
        store.step("r0", true, now); // rotate to r1
        let after = now + Duration::seconds(REFRESH_GRACE_SECONDS + 1);
        // Устаревший токен без крипто-привязки → 401 без ложного отзыва.
        let (decision, _) = store.step("legacy-old", false, after);
        assert_eq!(decision, RefreshDecision::Invalid);
        assert!(
            store.session.as_ref().unwrap().active,
            "чужая сессия не отозвана"
        );
    }

    #[test]
    fn missing_session_is_invalid() {
        let now = t0();
        assert_eq!(
            decide(None, None, "whatever", false, true, now),
            RefreshDecision::Invalid
        );
    }
}
