//! In-process SSE fan-out — паритет `UserRealtimeHub` (C#).

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use flora_notifications_contracts::{
    RealtimeConnectedSignal, RealtimeMessageSignal, RealtimeNotificationSignal,
    RealtimePresenceSignal, RealtimeReadSignal, RealtimeTypingSignal, SseConnectionHooks,
};
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct HubFrame {
    pub event: String,
    pub data: String,
}

/// Per-user unbounded channels; subscribe returns a stream + Drop-unsubscribe guard.
pub struct UserRealtimeHub {
    connections: Mutex<HashMap<Uuid, HashMap<Uuid, mpsc::UnboundedSender<HubFrame>>>>,
    hooks: Mutex<Arc<dyn SseConnectionHooks>>,
}

struct SubscriptionGuard {
    hub: Arc<UserRealtimeHub>,
    user_uuid: Uuid,
    connection_id: Uuid,
}

impl Drop for SubscriptionGuard {
    fn drop(&mut self) {
        self.hub.unsubscribe(self.user_uuid, self.connection_id);
    }
}

/// Stream of hub frames; unsubscribes when dropped (client disconnect).
pub struct HubFrameStream {
    rx: mpsc::UnboundedReceiver<HubFrame>,
    _guard: SubscriptionGuard,
}

impl futures_util::Stream for HubFrameStream {
    type Item = HubFrame;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

impl UserRealtimeHub {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            hooks: Mutex::new(Arc::new(
                flora_notifications_contracts::NoopSseConnectionHooks,
            )),
        }
    }

    pub fn set_connection_hooks(&self, hooks: Arc<dyn SseConnectionHooks>) {
        *self.hooks.lock().expect("hub hooks lock") = hooks;
    }

    pub fn subscribe(self: &Arc<Self>, user_uuid: Uuid) -> HubFrameStream {
        let connection_id = Uuid::now_v7();
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut map = self.connections.lock().expect("hub lock");
            map.entry(user_uuid)
                .or_default()
                .insert(connection_id, tx.clone());
        }
        {
            let hooks = self.hooks.lock().expect("hub hooks lock").clone();
            hooks.on_subscribe(user_uuid, connection_id);
        }
        let connected = RealtimeConnectedSignal { connection_id };
        if let Ok(json) = serde_json::to_string(&connected) {
            let _ = tx.send(HubFrame {
                event: "connected".into(),
                data: json,
            });
        }
        HubFrameStream {
            rx,
            _guard: SubscriptionGuard {
                hub: Arc::clone(self),
                user_uuid,
                connection_id,
            },
        }
    }

    pub fn unsubscribe(&self, user_uuid: Uuid, connection_id: Uuid) {
        {
            let mut map = self.connections.lock().expect("hub lock");
            let remove_user = if let Some(user_conns) = map.get_mut(&user_uuid) {
                user_conns.remove(&connection_id);
                user_conns.is_empty()
            } else {
                false
            };
            if remove_user {
                map.remove(&user_uuid);
            }
        }
        let hooks = self.hooks.lock().expect("hub hooks lock").clone();
        hooks.on_unsubscribe(user_uuid, connection_id);
    }

    pub fn publish_message(&self, user_uuid: Uuid, signal: &RealtimeMessageSignal) {
        self.broadcast(user_uuid, "message", signal);
    }

    pub fn publish_notification(&self, user_uuid: Uuid, signal: &RealtimeNotificationSignal) {
        self.broadcast(user_uuid, "notification", signal);
    }

    pub fn publish_presence_to_connection(
        &self,
        user_uuid: Uuid,
        connection_id: Uuid,
        signal: &RealtimePresenceSignal,
    ) {
        self.send_to_connection(user_uuid, connection_id, "presence", signal);
    }

    pub fn publish_typing(&self, user_uuid: Uuid, signal: &RealtimeTypingSignal) {
        self.broadcast(user_uuid, "typing", signal);
    }

    pub fn publish_read(&self, user_uuid: Uuid, signal: &RealtimeReadSignal) {
        self.broadcast(user_uuid, "read", signal);
    }

    fn broadcast<T: serde::Serialize>(&self, user_uuid: Uuid, event_name: &str, payload: &T) {
        let Ok(json) = serde_json::to_string(payload) else {
            return;
        };
        let frame = HubFrame {
            event: event_name.to_string(),
            data: json,
        };
        let map = self.connections.lock().expect("hub lock");
        let Some(user_conns) = map.get(&user_uuid) else {
            return;
        };
        for tx in user_conns.values() {
            let _ = tx.send(frame.clone());
        }
    }

    fn send_to_connection<T: serde::Serialize>(
        &self,
        user_uuid: Uuid,
        connection_id: Uuid,
        event_name: &str,
        payload: &T,
    ) {
        let Ok(json) = serde_json::to_string(payload) else {
            return;
        };
        let frame = HubFrame {
            event: event_name.to_string(),
            data: json,
        };
        let map = self.connections.lock().expect("hub lock");
        let Some(user_conns) = map.get(&user_uuid) else {
            return;
        };
        if let Some(tx) = user_conns.get(&connection_id) {
            let _ = tx.send(frame);
        }
    }
}

impl Default for UserRealtimeHub {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use futures_util::StreamExt;
    use std::sync::Arc;

    #[tokio::test]
    async fn publish_reaches_subscriber() {
        let hub = Arc::new(UserRealtimeHub::new());
        let user = Uuid::now_v7();
        let mut stream = hub.subscribe(user);
        // First frame is connected
        let connected = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .expect("timeout")
            .expect("frame");
        assert_eq!(connected.event, "connected");

        let signal = RealtimeMessageSignal {
            conversation_uuid: Uuid::now_v7(),
            sender_user_uuid: Uuid::now_v7(),
            sent_at: Utc::now(),
        };
        hub.publish_message(user, &signal);
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .expect("timeout")
            .expect("frame");
        assert_eq!(frame.event, "message");
        assert!(frame.data.contains("conversationUuid"));
    }

    #[tokio::test]
    async fn publish_notification_event_name() {
        let hub = Arc::new(UserRealtimeHub::new());
        let user = Uuid::now_v7();
        let mut stream = hub.subscribe(user);
        let _ = stream.next().await; // connected
        let signal = RealtimeNotificationSignal {
            notification_uuid: Uuid::now_v7(),
            notification_type: "like".into(),
            category: "social".into(),
            text: "Alice оценил ваш пост".into(),
            actor_user_uuid: Some(Uuid::now_v7()),
            post_uuid: Some(Uuid::now_v7()),
            comment_uuid: None,
            created_at: Utc::now(),
            update: None,
        };
        hub.publish_notification(user, &signal);
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .expect("timeout")
            .expect("frame");
        assert_eq!(frame.event, "notification");
        assert!(frame.data.contains("notificationUuid"));
        assert!(frame.data.contains("\"type\":\"like\""));
    }

    #[tokio::test]
    async fn publish_presence_to_one_connection() {
        let hub = Arc::new(UserRealtimeHub::new());
        let user = Uuid::now_v7();
        let mut a = hub.subscribe(user);
        let mut b = hub.subscribe(user);
        let a_conn = {
            let frame = a.next().await.expect("connected");
            let v: serde_json::Value = serde_json::from_str(&frame.data).unwrap();
            Uuid::parse_str(v["connectionId"].as_str().unwrap()).unwrap()
        };
        let _ = b.next().await;

        let signal = RealtimePresenceSignal {
            user_uuid: Uuid::now_v7(),
            is_online: true,
            last_seen_at: Some(Utc::now()),
        };
        hub.publish_presence_to_connection(user, a_conn, &signal);

        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), a.next())
            .await
            .expect("timeout")
            .expect("frame");
        assert_eq!(frame.event, "presence");

        let raced = tokio::time::timeout(std::time::Duration::from_millis(50), b.next()).await;
        assert!(raced.is_err() || raced.ok().flatten().is_none());
    }
}
