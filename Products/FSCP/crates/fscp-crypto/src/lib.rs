//! Portable FSCP crypto used by native consumers.
//! Message/session SoT remains `Products/FSCP/ts` (`@flora/fscp`); this crate
//! implements the bounded notification-preview decrypt surface for Android/iOS.

pub use fscp_contracts::{BOOTSTRAP_KEY_EPOCH_ID, WIRE_PREFIX};

mod notification_preview;

pub use notification_preview::{
    NotificationPreviewError, NotificationPreviewPlaintext, open_notification_preview,
};
