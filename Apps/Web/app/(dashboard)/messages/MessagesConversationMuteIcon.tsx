type MessagesConversationMuteIconProps = {
  className?: string;
};

/** Иконка мута в списке чатов (как в подменю «Заглушить»). */
export function MessagesConversationMuteIcon({ className }: MessagesConversationMuteIconProps) {
  return (
    <svg
      className={className}
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 5L6 9H3v6h3l5 4V5z" />
      <path d="M16 9l5 5M21 9l-5 5" />
    </svg>
  );
}
