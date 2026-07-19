//! `MessageSentNotifier` adapter — SSE hub + FCM push.
//!
//! Privacy-инвариант (e2e-security.md §Уведомления, FSCP errata-5): содержимое
//! сообщения через push/SSE не проходит — тело push всегда generic
//! («Новое сообщение»), plaintext-превью удалено из цепочки.

use std::sync::Arc;

use chrono::Utc;
use flora_messaging_contracts::{BoxFuture, MessageSentNotifier};
use flora_notifications_contracts::RealtimeMessageSignal;
use flora_shared::uuid_v5::dm_conversation_uuid;
use uuid::Uuid;

use crate::application::UserRealtimePublisher;

pub struct MessagePushNotifier {
    realtime: Arc<UserRealtimePublisher>,
}

impl MessagePushNotifier {
    pub fn new(realtime: Arc<UserRealtimePublisher>) -> Self {
        Self { realtime }
    }
}

impl MessageSentNotifier for MessagePushNotifier {
    fn notify(&self, recipient_user_uuid: Uuid, sender_user_uuid: Uuid) -> BoxFuture<'_, ()> {
        let realtime = Arc::clone(&self.realtime);
        Box::pin(async move {
            if recipient_user_uuid.is_nil() || sender_user_uuid.is_nil() {
                return;
            }
            if recipient_user_uuid == sender_user_uuid {
                return;
            }
            let conversation_uuid = dm_conversation_uuid(&sender_user_uuid, &recipient_user_uuid);
            let signal = RealtimeMessageSignal {
                conversation_uuid,
                sender_user_uuid,
                sent_at: Utc::now(),
            };
            realtime.publish_message(recipient_user_uuid, &signal).await;
        })
    }
}
