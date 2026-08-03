-- Никнеймы канонически в нижнем регистре (flora-shared::normalize_username).
-- Приводим legacy-строки с заглавными буквами; коллизии LOWER(username) маловероятны
-- при исторически case-sensitive UNIQUE, но защищаемся: обновляем только строки,
-- у которых нет «соседа» с тем же LOWER и другим user_uuid.

UPDATE flora_core.user_accounts AS ua
SET username = LOWER(ua.username),
    updated_at = NOW()
WHERE ua.username IS NOT NULL
  AND ua.username <> LOWER(ua.username)
  AND NOT EXISTS (
        SELECT 1
        FROM flora_core.user_accounts AS other
        WHERE other.user_uuid <> ua.user_uuid
          AND other.username IS NOT NULL
          AND LOWER(other.username) = LOWER(ua.username)
    );
