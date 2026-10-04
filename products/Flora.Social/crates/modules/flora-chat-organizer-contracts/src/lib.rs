//! Контракты модуля Chat Organizer — opaque FSCP-ORG wire без бизнес-логики.

use serde::{Deserialize, Serialize};

/// Ответ GET `/api/chat-organizer`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatOrganizerBlobDto {
    pub revision: i64,
    /// Opaque `fscporg1:…` wire (сервер не расшифровывает).
    pub wire: String,
    pub updated_at: String,
}

/// Тело PUT/POST `/api/chat-organizer`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PutChatOrganizerRequest {
    pub wire: String,
}
