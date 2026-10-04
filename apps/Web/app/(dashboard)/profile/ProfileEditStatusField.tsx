import { PROFILE_STATUS_MAX_LENGTH } from "./profileStatusValidation";
import styles from "./profile.module.css";

type ProfileEditStatusFieldProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export function ProfileEditStatusField({ id, value, onChange, disabled }: ProfileEditStatusFieldProps) {
  return (
    <>
      <label className={styles.profileEditLabel} htmlFor={id}>
        Статус (описание рядом с ником, макс. 3 строки)
      </label>
      <textarea
        id={id}
        className={styles.profileEditTextarea}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={PROFILE_STATUS_MAX_LENGTH}
        rows={3}
        placeholder="Коротко о себе (макс. 3 строки)"
        disabled={disabled}
      />
    </>
  );
}
