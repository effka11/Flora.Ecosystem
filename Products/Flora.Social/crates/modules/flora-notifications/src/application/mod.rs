//! Application: inbox, push tokens, message→SSE+FCM notifier (срез ServeNative).

mod dispatcher;
mod inbox;
mod message_notifier;
mod platform;
mod push_tokens;
mod realtime_publisher;
mod time;

pub use dispatcher::InboxNotificationDispatcher;
pub use inbox::InboxService;
pub use message_notifier::MessagePushNotifier;
pub use platform::client_platform_from_header;
pub use push_tokens::PushTokenService;
pub use realtime_publisher::UserRealtimePublisher;
