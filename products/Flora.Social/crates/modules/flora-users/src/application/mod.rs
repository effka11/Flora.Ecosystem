//! Application-слой Users: thin adapter — FIRA-P lives in `fira_core`.

pub mod avatar;
pub mod follow_notifications;
pub mod people_recommendation;
pub mod people_search;
pub mod post_image_processor;
pub mod presence;
pub mod profile;

pub use fira_core::people;
pub use presence::{MAX_WATCH_UUIDS, PresenceService, PresenceSnapshot};
