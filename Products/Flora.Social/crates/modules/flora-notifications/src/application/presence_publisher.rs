//! PresenceRealtimePublisher backed by UserRealtimeHub.

use std::sync::Arc;

use flora_notifications_contracts::{PresenceRealtimePublisher, RealtimePresenceSignal};
use uuid::Uuid;

use crate::infrastructure::UserRealtimeHub;

pub struct HubPresencePublisher {
    hub: Arc<UserRealtimeHub>,
}

impl HubPresencePublisher {
    pub fn new(hub: Arc<UserRealtimeHub>) -> Self {
        Self { hub }
    }
}

impl PresenceRealtimePublisher for HubPresencePublisher {
    fn publish_to_connection(
        &self,
        recipient_user_uuid: Uuid,
        connection_id: Uuid,
        signal: &RealtimePresenceSignal,
    ) {
        self.hub
            .publish_presence_to_connection(recipient_user_uuid, connection_id, signal);
    }
}
