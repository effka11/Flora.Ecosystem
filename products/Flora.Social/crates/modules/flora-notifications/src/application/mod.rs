//! Application: inbox, push tokens, message→SSE+FCM notifier (срез ServeNative).

mod dispatcher;
mod inbox;
mod message_notifier;
mod notifications_search;
mod platform;
mod presence_publisher;
mod push_tokens;
mod read_notifier;
mod realtime_publisher;
mod social;
mod time;
mod typing_notifier;

pub use dispatcher::InboxNotificationDispatcher;
pub use inbox::InboxService;
pub use message_notifier::MessagePushNotifier;
pub use notifications_search::NotificationSearchIndex;
pub use platform::client_platform_from_header;
pub use presence_publisher::HubPresencePublisher;
pub use push_tokens::{PushTokenService, SecurePreviewRegistration};
pub use read_notifier::HubReadNotifier;
pub use realtime_publisher::UserRealtimePublisher;
pub use typing_notifier::HubTypingNotifier;
