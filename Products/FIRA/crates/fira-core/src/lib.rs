//! FIRA core — pure recommendation scorers (functional product).
//! Spec: `Documents/fira/FIRA.md`. Social modules only prepare DB candidates and call these.

pub mod communities;
pub mod feed;
pub mod music;
pub mod people;

pub use fira_contracts::{
    AuthorDiversity, ExplorationLevel, FeedFreshness, FeedPreferences, InterestProfile,
    InterestTopicWeight, SeenPostsMode,
};
