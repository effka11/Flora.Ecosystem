//! Application-слой Music: FIRA-M adapter + read services.

pub use fira_core::music as recommendations;

pub mod artists;
pub mod audio_search;
pub mod credits;
pub mod flow;
pub mod genres;
pub mod playlists;
pub mod time;
pub mod tracks;
pub mod upload;
pub mod upload_validation;
pub mod workers;
