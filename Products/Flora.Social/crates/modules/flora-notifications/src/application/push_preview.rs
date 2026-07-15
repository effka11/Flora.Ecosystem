//! Push body preview — паритет `MessagePushPreviewBuilder.cs`.

use flora_messaging_contracts::MessageSentPushContext;

pub fn build_push_preview(context: Option<&MessageSentPushContext>) -> String {
    if let Some(preview) = context.and_then(|c| c.push_preview.as_deref())
        && !preview.is_empty()
    {
        return truncate(preview);
    }
    if context.is_some_and(|c| c.has_voice_attachment) {
        return "Голосовое сообщение".into();
    }
    if context.is_some_and(|c| c.has_image_attachment) {
        return "Фото".into();
    }
    if context.is_some_and(|c| c.has_video_attachment) {
        return "Видео".into();
    }
    "Новое сообщение".into()
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= 120 {
        text.to_string()
    } else {
        format!("{}...", text.chars().take(117).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_new_message() {
        assert_eq!(build_push_preview(None), "Новое сообщение");
    }

    #[test]
    fn voice_takes_precedence_without_preview() {
        let ctx = MessageSentPushContext {
            push_preview: None,
            has_voice_attachment: true,
            has_image_attachment: true,
            has_video_attachment: false,
        };
        assert_eq!(build_push_preview(Some(&ctx)), "Голосовое сообщение");
    }
}
