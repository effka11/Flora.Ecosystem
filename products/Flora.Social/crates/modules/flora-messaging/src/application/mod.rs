//! Application: диалоги, unread, assets, E2E state (срез ServeNative).

mod assets;
mod chat_list;
mod conversations;
mod cursor;
mod e2e;
mod e2e_epochs;
mod franking;
mod groups;
#[cfg(test)]
mod test_ports;

pub use assets::{AssetBlob, AssetError, AssetService};
pub use chat_list::{ChatListError, ChatListService};
pub use conversations::{
    ConversationListItemWithBlockDto, ConversationService, ConversationsPageWithBlocksDto,
    SendMessageError,
};
pub use cursor::{decode_cursor, encode_cursor};
pub use e2e::{
    E2eKeyBackupService, GetE2ePublicKeyError, PutKeyBackupError, PutRecoveryBackupError,
    SetE2ePublicKeyError,
};
pub use e2e_epochs::{
    AddPendingDeviceError, ApproveDeviceError, CreateEpochError, E2eEpochService, RecoverKeyError,
    RevokeDeviceError, UnlockChallengeError, UnlockCompleteError,
};
pub use franking::{
    FrankingError, FrankingService, FrankingSigner, MAX_ACCOUNT_BLOCK_DAYS, MIN_ACCOUNT_BLOCK_DAYS,
    SIGNING_UNAVAILABLE_CODE, TaggedIngest, parse_franking_seed, parse_reviewer_uuids,
    signing_unavailable_body, tagged_ingest_action,
};
pub use groups::{GroupDetailWithBlocksDto, GroupMemberWithBlockDto, GroupSendError, GroupService};
