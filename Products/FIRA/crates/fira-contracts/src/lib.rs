//! FIRA contracts — types owned by the functional product (not Users/Content modules).
//! Spec: `Documents/fira/FIRA.md`. Users persists UIP and maps into [`InterestProfile`].

use serde::{Deserialize, Serialize};

/// User Interest Profile (UIP) — shared across FIRA-F/P/C/M.
/// Persistence stays in Social Users; this DTO is the portable contract.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InterestProfile {
    /// Topic weights or opaque feature vector entries (v1 may be empty / Phase-0 unused).
    pub topics: Vec<InterestTopicWeight>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InterestTopicWeight {
    pub topic_id: String,
    pub weight: f64,
}
