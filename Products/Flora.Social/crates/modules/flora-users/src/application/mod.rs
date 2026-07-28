//! Application-слой Users: thin adapter — FIRA-P lives in `fira_core`.

pub mod avatar;
pub mod people_recommendation;
pub mod post_image_processor;
pub mod presence;

pub use fira_core::people;
pub use presence::{PresenceService, PresenceSnapshot, MAX_WATCH_UUIDS};
