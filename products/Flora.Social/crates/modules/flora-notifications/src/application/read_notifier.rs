//! MessageReadNotifier → SSE `event: read` (no FCM).

use std::sync::Arc;

use flora_messaging_contracts::{BoxFuture, MessageReadNotifier};
use flora_notifications_contracts::RealtimeReadSignal;
use uuid::Uuid;

use crate::infrastructure::UserRealtimeHub;

pub struct HubReadNotifier {
    hub: Arc<UserRealtimeHub>,
}

impl HubReadNotifier {
    pub fn new(hub: Arc<UserRealtimeHub>) -> Self {
        Self { hub }
    }
}

impl MessageReadNotifier for HubReadNotifier {
    fn notify_read(
        &self,
        recipient_user_uuid: Uuid,
        conversation_uuid: Uuid,
        reader_user_uuid: Uuid,
    ) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let signal = RealtimeReadSignal {
                conversation_uuid,
                reader_user_uuid,
            };
            self.hub.publish_read(recipient_user_uuid, &signal);
        })
    }
}
