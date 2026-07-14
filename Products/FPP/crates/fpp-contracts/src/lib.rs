//! FPP contracts — personhood ports for Governance/Economy consumers.
//! Spec: `docs/fpp/FPP.md`. Persistence (`personhood_*`) is owned by Social Verification.

/// Personhood attestation level V0–V3 (normative names; full API lands with Verification cutover).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PersonhoodLevel {
    V0 = 0,
    V1 = 1,
    V2 = 2,
    V3 = 3,
}
