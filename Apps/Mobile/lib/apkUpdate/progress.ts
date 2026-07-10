export type ApkUpdatePhase =
  | "checking"
  | "permission"
  | "downloading"
  | "verifying"
  | "installing"
  | "done"
  | "error";

export type ApkUpdateProgress = {
  phase: ApkUpdatePhase;
  /** 0..1 when known (download). */
  fraction?: number;
  message?: string;
  /** Machine code for UI actions (e.g. NO_PERMISSION → «Разрешить»). */
  code?: string;
};

export type ApkUpdateProgressListener = (progress: ApkUpdateProgress) => void;

export function labelForApkUpdatePhase(phase: ApkUpdatePhase): string {
  switch (phase) {
    case "checking":
      return "Проверка обновления…";
    case "permission":
      return "Нужно разрешение на установку…";
    case "downloading":
      return "Загрузка обновления…";
    case "verifying":
      return "Проверка файла…";
    case "installing":
      return "Установка… Подтвердите в системном окне, если появится";
    case "done":
      return "Готово";
    case "error":
      return "Ошибка обновления";
  }
}
