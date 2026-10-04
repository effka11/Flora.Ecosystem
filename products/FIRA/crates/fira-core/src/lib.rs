//! FIRA core — pure recommendation scorers (functional product).
//! Spec: `documents/fira/FIRA.md`. Social modules only prepare DB candidates and call these.

pub mod communities;
pub mod feed;
pub mod music;
pub mod people;

pub use fira_contracts::{
    AuthorDiversity, ExplorationLevel, FeedFreshness, FeedPreferences, InterestProfile,
    InterestTopicWeight, SeenPostsMode,
};
