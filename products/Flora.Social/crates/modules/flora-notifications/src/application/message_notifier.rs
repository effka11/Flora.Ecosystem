//! `MessageSentNotifier` adapter — SSE hub + FCM push.
//!
//! Privacy-инвариант (e2e-security.md §Уведомления, FSCP errata-5): содержимое
//! сообщения через push/SSE не проходит — тело push всегда generic
//! («Новое сообщение»), plaintext-превью удалено из цепочки.

use std::sync::Arc;

use crate::application::UserRealtimePublisher;
use chrono::Utc;
use flora_messaging_contracts::{BoxFuture, MessageSentContext, MessageSentNotifier};
use flora_notifications_contracts::RealtimeMessageSignal;

pub struct MessagePushNotifier {
    realtime: Arc<UserRealtimePublisher>,
}

impl MessagePushNotifier {
    pub fn new(realtime: Arc<UserRealtimePublisher>) -> Self {
        Self { realtime }
    }
}

impl MessageSentNotifier for MessagePushNotifier {
    fn notify(&self, context: MessageSentContext) -> BoxFuture<'_, ()> {
        let realtime = Arc::clone(&self.realtime);
        Box::pin(async move {
            let recipient_user_uuid = context.recipient_user_uuid;
            let sender_user_uuid = context.sender_user_uuid;
            if recipient_user_uuid.is_nil() || sender_user_uuid.is_nil() {
                return;
            }
            if recipient_user_uuid == sender_user_uuid {
                return;
            }
            let conversation_uuid = context.conversation_uuid;
            if conversation_uuid.is_nil() {
                return;
            }
            let signal = RealtimeMessageSignal {
                conversation_uuid,
                sender_user_uuid,
                sent_at: Utc::now(),
                kind: Some(context.kind.as_realtime_str().into()),
            };
            realtime
                .publish_message(recipient_user_uuid, &signal, &context)
                .await;
        })
    }
}
