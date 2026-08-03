//! Application: диалоги, unread, assets, E2E state (срез ServeNative).

mod assets;
mod chat_list;
mod conversations;
mod cursor;
mod e2e;
mod e2e_epochs;
mod groups;

pub use assets::{AssetBlob, AssetError, AssetService};
pub use chat_list::{ChatListError, ChatListService};
pub use conversations::{ConversationService, SendMessageError};
pub use cursor::{decode_cursor, encode_cursor};
pub use e2e::{
    E2eKeyBackupService, GetE2ePublicKeyError, PutKeyBackupError, PutRecoveryBackupError,
    SetE2ePublicKeyError,
};
pub use e2e_epochs::{
    AddPendingDeviceError, ApproveDeviceError, CreateEpochError, E2eEpochService, RecoverKeyError,
    RevokeDeviceError, UnlockChallengeError, UnlockCompleteError,
};
pub use groups::{GroupSendError, GroupService};
