//! sqlx-доступ к таблицам Messaging (`user_messages`, …).

mod assets;
mod e2e;
mod e2e_epochs;
mod repo;

pub use assets::*;
pub use e2e::*;
pub use e2e_epochs::*;
pub use repo::MessagingRepo;
