import type { MessageReplyDraft } from "./messageReply";
import styles from "./messages.module.css";

type MessageComposeReplyBarProps = {
  reply: MessageReplyDraft;
  onDismiss: () => void;
};

export function MessageComposeReplyBar({ reply, onDismiss }: MessageComposeReplyBarProps) {
  return (
    <div className={styles.messagesComposeReplyStrip} role="status" aria-live="polite">
      <div className={styles.messagesComposeReplyItem}>
        <span className={styles.messagesComposeReplyAccent} aria-hidden />
        <div className={styles.messagesComposeReplyText}>
          <span className={styles.messagesComposeReplyAuthor}>{reply.authorDisplayName}</span>
          <span className={styles.messagesComposeReplyPreview}>{reply.preview}</span>
        </div>
        <button
          type="button"
          className={styles.messagesComposeImageRemove}
          aria-label="Отменить ответ"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
}
