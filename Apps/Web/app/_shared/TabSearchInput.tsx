"use client";

type TabSearchInputClassNames = {
  wrap: string;
  box: string;
  icon: string;
  input: string;
  actionButton?: string;
  actionButtonShown?: string;
  actionButtonHidden?: string;
};

type TabSearchInputProps = {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  classNames: TabSearchInputClassNames;
  actionAriaLabel?: string;
  showActionButton?: boolean;
};

export function TabSearchInput({
  placeholder,
  value,
  onChange,
  classNames,
  actionAriaLabel = "Поиск",
  showActionButton = true
}: TabSearchInputProps) {
  const hasQuery = value.trim().length > 0;

  return (
    <div className={classNames.wrap}>
      <div className={classNames.box}>
        <svg className={classNames.icon} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
        </svg>
        <input
          type="text"
          className={classNames.input}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {showActionButton && classNames.actionButton && hasQuery ? (
          <button
            type="button"
            className={`${classNames.actionButton}${classNames.actionButtonShown ? ` ${classNames.actionButtonShown}` : ""}`}
            aria-label={actionAriaLabel}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );
}
