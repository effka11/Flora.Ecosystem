# Flora — ассеты знака

Канон рисунка — `packages/flora-design/assets/flora-logo-v1.svg`: кадр 1024×1024, пластина `#0a0a0a`, растение `#a1cd87`. Рядом лежит растр того же кадра, `flora-logo-v1.png`.

Производные копии пишет `node scripts/render-flora-mobile-assets.mjs`. Исходник правки — svg в `@flora/design`; оболочки получают уже собранные файлы.

Зафиксировано: **2026-10-20**.

---

## Канон

| Файл | Роль |
|------|------|
| `packages/flora-design/assets/flora-logo-v1.svg` | Исходный знак |
| `packages/flora-design/assets/flora-logo-v1.png` | Растр того же кадра |

---

## Публичные адреса (apps/Web)

Хост Social: `https://social.flora-s.net`.

| Адрес | Файл | Роль |
|-------|------|------|
| `https://social.flora-s.net/logo-mark.svg` | `apps/Web/public/logo-mark.svg` | Знак без пластины, угол оболочки (`FloraLogoMark`) |
| `https://social.flora-s.net/icon.svg` | `apps/Web/public/icon.svg` | Вкладка: тот же знак, более плотный кадр |
| `https://social.flora-s.net/favicon-32.png` | `apps/Web/public/favicon-32.png` | PNG 32×32 |
| `https://social.flora-s.net/apple-icon.png` | `apps/Web/public/apple-icon.png` | Apple touch icon 180×180 |

Файлы соглашения Next лежат в `apps/Web/app/` и перекрывают вкладку поверх `public/`:

| Файл | Роль |
|------|------|
| `apps/Web/app/icon.png` | Вкладка, 32×32 |
| `apps/Web/app/apple-icon.png` | Apple touch icon, 180×180 |

Метаданные вкладки: `apps/Web/app/layout.tsx`.

---

## Mobile

Каталог `apps/Mobile/assets/images/`. Сборка читает их из `apps/Mobile/app.json`.

| Файл | Роль |
|------|------|
| `icon.png`, `icon-dev.png` | Иконка приложения, поле `#2c3527` |
| `android-icon-foreground.png` | Передний слой adaptive icon |
| `android-icon-monochrome.png` | Монохромный слой, белые чернила |
| `android-icon-background.png`, `android-icon-background-dev.png` | Заливка поля `#2c3527` |
| `splash-icon.png` | Splash |
| `notification-icon.png` | Иконка уведомления |
| `favicon.png` | Favicon веб-сборки Expo |

Угол меню на устройстве рисует тот же контур без пластины, строкой `FLORA_LOGO_MARK_D` в `apps/Mobile/components/FeedHamburgerMenu.tsx`.

Гражданский портал рисует знак прямо в `apps/Gov/app/_shell/GovShell.tsx` и эти файлы не подключает.
