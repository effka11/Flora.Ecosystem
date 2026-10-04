import styles from "./profile.module.css";

type ProfileCardStatusProps = {
  status: string | null | undefined;
  /** Пока грузится публичный профиль — краткий плейсхолдер в блоке статуса. */
  loading?: boolean;
};

/** Статус рядом с аватаром (как Profile.razor в 2142-1); пустой — блок не рендерится. */
export function ProfileCardStatus({ status, loading = false }: ProfileCardStatusProps) {
  const trimmed = (status ?? "").trim();

  if (!trimmed) {
    if (!loading) return null;
    return (
      <p className={styles.profileStatus}>
        <span className={styles.profileStatusText}>…</span>
      </p>
    );
  }

  return (
    <p className={styles.profileStatus}>
      <span className={styles.profileStatusText}>{trimmed}</span>
    </p>
  );
}
