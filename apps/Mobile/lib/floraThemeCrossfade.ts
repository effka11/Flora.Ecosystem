import type { FloraThemeCrossfadeApi } from "flora-theme-crossfade";

/**
 * Растворение снимка старой темы. Кривая — симметричная `--flora-ease-in`
 * (см. `REVEAL_INTERPOLATOR` в модуле): 10/50/90% проходятся за
 * 24/50/76% времени. 240 мс при такой кривой читаются как растворение;
 * 180 мс с фронт-загруженным easing давали подмену за 2–3 кадра.
 */
export const THEME_CROSSFADE_MS = 240;

/**
 * Стратегия применения палитры. `apply` меняет палитру синхронно и возвращает
 * `true`, если применённая тема действительно изменилась (будет коммит React
 * и `reveal` из провайдера).
 */
export type FloraThemeTransition = (apply: () => boolean) => void;

/** Без кроссфейда: палитра меняется сразу (тесты, iOS, старый dev-build). */
export const instantFloraThemeTransition: FloraThemeTransition = (apply) => {
  apply();
};

/**
 * Кроссфейд: сначала нативный снимок закрывает экран, затем палитра меняется
 * под ним. Растворение после коммита нового дерева запускает `FloraThemeProvider`.
 * Если за время съёмки выбор откатили и палитра не изменилась — коммита не будет,
 * снимок убираем сами (`reveal(0)`; при уже запланированном растворении это no-op).
 *
 * Пока снимок снимается, новые `apply` не запускают второй `freeze`: отложенный
 * `apply` сам прочитает актуальный выбор из store, а второй `freeze` отменил бы
 * сессию первого и палитра успела бы смениться без снимка (вспышка).
 */
export function createFloraThemeTransition(
  crossfade: FloraThemeCrossfadeApi | null,
): FloraThemeTransition {
  if (!crossfade) return instantFloraThemeTransition;
  let freezing = false;
  return (apply) => {
    if (freezing) return;
    freezing = true;
    crossfade.freeze().then(
      (covering) => {
        freezing = false;
        const changed = apply();
        if (covering && !changed) crossfade.reveal(0);
      },
      () => {
        freezing = false;
        apply();
      },
    );
  };
}
