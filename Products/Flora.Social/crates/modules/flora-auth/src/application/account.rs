//! Смена пароля и удаление аккаунта — паритет ImportedSocialController.

use std::sync::Arc;

use flora_users_contracts::UserProfileProvisioner;
use uuid::Uuid;

use crate::infrastructure::password::{MAX_PASSWORD_BYTES, hash_password, verify_password};
use crate::infrastructure::repo::AuthRepo;

#[derive(Debug)]
pub enum ChangePasswordError {
    BadRequest(&'static str),
    NotFound(&'static str),
    Internal(String),
}

#[derive(Debug)]
pub enum DeleteAccountError {
    BadRequest(&'static str),
    NotFound(&'static str),
    Internal(String),
}

pub struct AccountService {
    repo: Arc<AuthRepo>,
    provisioner: Arc<dyn UserProfileProvisioner>,
}

impl AccountService {
    pub fn new(repo: Arc<AuthRepo>, provisioner: Arc<dyn UserProfileProvisioner>) -> Self {
        Self { repo, provisioner }
    }

    pub async fn change_password(
        &self,
        user_uuid: Uuid,
        current_session_id: Uuid,
        current_password: &str,
        new_password: &str,
    ) -> Result<(), ChangePasswordError> {
        if current_password.trim().is_empty() {
            return Err(ChangePasswordError::BadRequest("Укажите текущий пароль."));
        }
        if new_password.trim().is_empty() {
            return Err(ChangePasswordError::BadRequest("Укажите новый пароль."));
        }
        if new_password.chars().count() < 8 {
            return Err(ChangePasswordError::BadRequest(
                "Новый пароль должен быть не короче 8 символов.",
            ));
        }
        if new_password.len() > MAX_PASSWORD_BYTES {
            return Err(ChangePasswordError::BadRequest(
                "Новый пароль слишком длинный.",
            ));
        }

        let Some(stored) = self
            .repo
            .get_password_hash(user_uuid)
            .await
            .map_err(|e| ChangePasswordError::Internal(e.to_string()))?
        else {
            return Err(ChangePasswordError::NotFound("Аккаунт не найден."));
        };

        let current_owned = current_password.to_string();
        let stored_owned = stored.clone();
        let ok =
            tokio::task::spawn_blocking(move || verify_password(&current_owned, &stored_owned))
                .await
                .map_err(|e| ChangePasswordError::Internal(e.to_string()))?;
        if !ok {
            return Err(ChangePasswordError::BadRequest("Неверный текущий пароль."));
        }

        let new_owned = new_password.to_string();
        let new_hash = tokio::task::spawn_blocking(move || hash_password(&new_owned))
            .await
            .map_err(|e| ChangePasswordError::Internal(e.to_string()))?;

        let now = chrono::Utc::now();
        self.repo
            .update_password_hash(user_uuid, &new_hash, now)
            .await
            .map_err(|e| ChangePasswordError::Internal(e.to_string()))?;

        self.repo
            .revoke_other_sessions_for_password_except_id(user_uuid, Some(current_session_id), now)
            .await
            .map_err(|e| ChangePasswordError::Internal(e.to_string()))?;

        Ok(())
    }

    pub async fn delete_account(
        &self,
        user_uuid: Uuid,
        password: &str,
    ) -> Result<(), DeleteAccountError> {
        let Some(stored) = self
            .repo
            .get_password_hash(user_uuid)
            .await
            .map_err(|e| DeleteAccountError::Internal(e.to_string()))?
        else {
            return Err(DeleteAccountError::NotFound("Аккаунт не найден."));
        };

        if password.trim().is_empty() {
            return Err(DeleteAccountError::BadRequest("Неверный пароль."));
        }

        let password_owned = password.to_string();
        let stored_owned = stored;
        let ok =
            tokio::task::spawn_blocking(move || verify_password(&password_owned, &stored_owned))
                .await
                .map_err(|e| DeleteAccountError::Internal(e.to_string()))?;
        if !ok {
            return Err(DeleteAccountError::BadRequest("Неверный пароль."));
        }

        let deleted = self
            .repo
            .delete_user_account(user_uuid)
            .await
            .map_err(|e| DeleteAccountError::Internal(e.to_string()))?;
        if deleted == 0 {
            return Err(DeleteAccountError::NotFound("Аккаунт не найден."));
        }
        if let Err(error) = self.provisioner.forget_user(user_uuid).await {
            tracing::warn!(
                %error,
                %user_uuid,
                "profile forget after account delete failed"
            );
        }
        Ok(())
    }
}
