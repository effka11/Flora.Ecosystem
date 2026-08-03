//! sqlx-доступ к таблицам Messaging (`user_messages`, …).

mod assets;
mod chat_list;
mod e2e;
mod e2e_d2d_recovery;
mod e2e_epochs;
mod e2e_tokens;
mod groups;
mod repo;

pub use assets::*;
pub use chat_list::ChatListRepo;
pub use e2e::*;
pub use e2e_d2d_recovery::*;
pub use e2e_epochs::*;
pub use e2e_tokens::E2eProofTokens;
pub use groups::{GroupRepo, InsertMessageOutcome};
pub use repo::MessagingRepo;
