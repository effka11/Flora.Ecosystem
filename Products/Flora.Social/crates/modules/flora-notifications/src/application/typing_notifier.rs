//! MessageTypingNotifier → SSE `event: typing` (no FCM).
//! Coalesces repeated `is_typing: true` to ~1/s per (recipient, conversation, sender).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use flora_messaging_contracts::{BoxFuture, MessageTypingNotifier};
use flora_notifications_contracts::RealtimeTypingSignal;
use uuid::Uuid;

use crate::infrastructure::UserRealtimeHub;

const TYPING_TRUE_COALESCE: Duration = Duration::from_secs(1);
const TYPING_TRUE_TTL: Duration = Duration::from_secs(5 * 60);

pub struct HubTypingNotifier {
    hub: Arc<UserRealtimeHub>,
    last_true: Mutex<HashMap<(Uuid, Uuid, Uuid), Instant>>,
}

impl HubTypingNotifier {
    pub fn new(hub: Arc<UserRealtimeHub>) -> Self {
        Self {
            hub,
            last_true: Mutex::new(HashMap::new()),
        }
    }

    fn prune_stale(map: &mut HashMap<(Uuid, Uuid, Uuid), Instant>, now: Instant) {
        map.retain(|_, at| now.duration_since(*at) < TYPING_TRUE_TTL);
    }
}

impl MessageTypingNotifier for HubTypingNotifier {
    fn notify_typing(
        &self,
        recipient_user_uuid: Uuid,
        conversation_uuid: Uuid,
        sender_user_uuid: Uuid,
        is_typing: bool,
    ) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let key = (recipient_user_uuid, conversation_uuid, sender_user_uuid);
            if is_typing {
                let mut map = self.last_true.lock().expect("typing coalesce lock");
                let now = Instant::now();
                Self::prune_stale(&mut map, now);
                if let Some(prev) = map.get(&key)
                    && now.duration_since(*prev) < TYPING_TRUE_COALESCE
                {
                    return;
                }
                map.insert(key, now);
            } else {
                let mut map = self.last_true.lock().expect("typing coalesce lock");
                map.remove(&key);
                Self::prune_stale(&mut map, Instant::now());
            }
            let signal = RealtimeTypingSignal {
                conversation_uuid,
                user_uuid: sender_user_uuid,
                is_typing,
            };
            self.hub.publish_typing(recipient_user_uuid, &signal);
        })
    }
}
