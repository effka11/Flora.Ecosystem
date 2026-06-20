import type { FscpMessageReplyRef } from "@/lib/fscp";
import styles from "./messages.module.css";

type MessageBubbleReplyQuoteProps = {
  reply: FscpMessageReplyRef;
  isFromMe: boolean;
};

export function MessageBubbleReplyQuote({ reply, isFromMe }: MessageBubbleReplyQuoteProps) {
  return (
    <div
      className={`${styles.messagesBubbleReply} ${isFromMe ? styles.messagesBubbleReplyMe : styles.messagesBubbleReplyThem}`}
      aria-label={`Ответ на сообщение ${reply.authorDisplayName}`}
    >
      <span className={styles.messagesBubbleReplyAuthor}>{reply.authorDisplayName}</span>
      <span className={styles.messagesBubbleReplyPreview}>{reply.preview}</span>
    </div>
  );
}
