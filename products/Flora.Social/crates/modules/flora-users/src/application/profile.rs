//! Profile writes owned by Users. HTTP validates the request; this layer
//! persists Auth username + profile fields and updates FSA-P.

use flora_auth_contracts::AccountDirectory;
use flora_users_contracts::UserProfileQueries;
use uuid::Uuid;

use crate::application::people_search::PeopleSearchHost;

pub enum PersistProfileError {
    NotFound,
    UsernameTaken,
    BadRequest(String),
    Internal(String),
}

pub struct PersistProfileUpdate<'a> {
    pub user_uuid: Uuid,
    pub username: String,
    pub display_name: &'a str,
    pub gender: Option<i32>,
    pub birth_date: Option<&'a str>,
    pub status: Option<&'a str>,
}

pub async fn persist_profile_update(
    accounts: &dyn AccountDirectory,
    profiles: &dyn UserProfileQueries,
    people_search: &PeopleSearchHost,
    update: PersistProfileUpdate<'_>,
) -> Result<(), PersistProfileError> {
    let Some(account) = accounts
        .get_public(update.user_uuid)
        .await
        .map_err(PersistProfileError::Internal)?
    else {
        return Err(PersistProfileError::NotFound);
    };

    if !update.username.is_empty() {
        if accounts
            .username_taken_by_other(&update.username, update.user_uuid)
            .await
            .map_err(PersistProfileError::Internal)?
        {
            return Err(PersistProfileError::UsernameTaken);
        }
        accounts
            .update_username(update.user_uuid, &update.username)
            .await
            .map_err(PersistProfileError::Internal)?;
    }

    let birth = update.birth_date.map(str::trim);
    if let Err(e) = profiles
        .upsert_profile_fields(
            update.user_uuid,
            if update.display_name.is_empty() {
                None
            } else {
                Some(update.display_name)
            },
            update.gender,
            birth,
            update.status,
            &account.username,
        )
        .await
    {
        if e.starts_with("Неверный формат") {
            return Err(PersistProfileError::BadRequest(e));
        }
        return Err(PersistProfileError::Internal(e));
    }

    let indexed_username = if update.username.is_empty() {
        account.username
    } else {
        update.username
    };
    if let Err(e) = people_search
        .sync_user(update.user_uuid, indexed_username, profiles)
        .await
    {
        tracing::warn!(
            error = %e,
            user_uuid = %update.user_uuid,
            "people search sync after profile update failed"
        );
    }
    Ok(())
}
