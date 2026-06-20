"use client";

import { useSettings } from "./SettingsContext";
import styles from "./settings.module.css";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        className={styles.toggleInput}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className={styles.toggleTrack}>
        <div className={styles.toggleThumb} />
      </div>
    </label>
  );
}

function Checkbox() {
  return <input type="checkbox" className={styles.checkboxInput} defaultChecked />;
}

export function SettingsNotificationsTab() {
  const { draft, updateNotifications, clearSaveFeedback } = useSettings();
  const { notifications } = draft;

  const patch = (next: Partial<typeof notifications>) => {
    clearSaveFeedback();
    updateNotifications(next);
  };

  return (
    <div className={styles.tabContent}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Каналы уведомлений</h3>
        <div className={styles.listCard}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>Браузерные уведомления (Push)</p>
            <p className={styles.listCardDesc}>Получать уведомления, когда вкладка закрыта</p>
          </div>
          <Toggle checked={notifications.pushEnabled} onChange={(pushEnabled) => patch({ pushEnabled })} />
        </div>
        <div className={styles.listCard}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>Email уведомления</p>
            <p className={styles.listCardDesc}>Дайджесты и важные оповещения на почту</p>
          </div>
          <Toggle checked={notifications.emailEnabled} onChange={(emailEnabled) => patch({ emailEnabled })} />
        </div>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Режим тишины</h3>
        <div
          className={styles.listCard}
          style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--flora-grid-step)" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className={styles.listCardInfo}>
              <p className={styles.listCardTitle}>Тихий режим по расписанию</p>
              <p className={styles.listCardDesc}>Отключать звуки и push-уведомления в заданное время</p>
            </div>
            <Toggle checked={notifications.quietMode} onChange={(quietMode) => patch({ quietMode })} />
          </div>

          {notifications.quietMode ? (
            <div
              className={styles.settingsQuietModeExpand}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "calc(1.5 * var(--flora-grid-step))",
                paddingTop: "calc(1.5 * var(--flora-grid-step))",
              }}
            >
              <div style={{ display: "flex", gap: "calc(2 * var(--flora-grid-step))" }}>
                <div className={styles.formGroup} style={{ flex: 1 }}>
                  <label className={styles.label} htmlFor="notifications-quiet-from">
                    С
                  </label>
                  <input
                    id="notifications-quiet-from"
                    type="time"
                    className={styles.input}
                    value={notifications.quietFrom}
                    onChange={(e) => patch({ quietFrom: e.target.value })}
                  />
                </div>
                <div className={styles.formGroup} style={{ flex: 1 }}>
                  <label className={styles.label} htmlFor="notifications-quiet-to">
                    До
                  </label>
                  <input
                    id="notifications-quiet-to"
                    type="time"
                    className={styles.input}
                    value={notifications.quietTo}
                    onChange={(e) => patch({ quietTo: e.target.value })}
                  />
                </div>
              </div>
              <label className={styles.checkboxWrap}>
                <input
                  type="checkbox"
                  className={styles.checkboxInput}
                  checked={notifications.quietAllowImportant}
                  onChange={(e) => patch({ quietAllowImportant: e.target.checked })}
                />
                <span>Оставлять важные уведомления (упоминания, личные сообщения)</span>
              </label>
            </div>
          ) : null}
        </div>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Матрица событий</h3>
        <div className={styles.matrixTableWrap}>
          <table className={styles.matrixTable}>
            <thead>
              <tr>
                <th>Событие</th>
                <th>В приложении</th>
                <th>Браузер (Push)</th>
                <th>Email</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Личные сообщения</td>
                <td><Checkbox /></td>
                <td><Checkbox /></td>
                <td><Checkbox /></td>
              </tr>
              <tr>
                <td>Упоминания (@никнейм)</td>
                <td><Checkbox /></td>
                <td><Checkbox /></td>
                <td><Checkbox /></td>
              </tr>
              <tr>
                <td>Заявки в друзья</td>
                <td><Checkbox /></td>
                <td><Checkbox /></td>
                <td><Checkbox /></td>
              </tr>
              <tr>
                <td>Лайки и реакции</td>
                <td><Checkbox /></td>
                <td><Checkbox /></td>
                <td><input type="checkbox" className={styles.checkboxInput} /></td>
              </tr>
              <tr>
                <td>Новые посты друзей</td>
                <td><Checkbox /></td>
                <td><input type="checkbox" className={styles.checkboxInput} /></td>
                <td><input type="checkbox" className={styles.checkboxInput} /></td>
              </tr>
              <tr>
                <td>Приглашения в сообщества</td>
                <td><Checkbox /></td>
                <td><Checkbox /></td>
                <td><Checkbox /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
