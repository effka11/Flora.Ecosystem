//! FSCP contracts — shared constants for the functional product.
//! Spec: `Documents/fscp/FSCP.md`. Server validation lives in `fscp-core`.

use uuid::Uuid;

/// Wire prefix `fscp1:`.
pub const WIRE_PREFIX: &str = "fscp1:";

/// Bootstrap key epoch FSCP v1.
pub const BOOTSTRAP_KEY_EPOCH_ID: Uuid = uuid::uuid!("00000000-0000-4000-8000-000000000001");
