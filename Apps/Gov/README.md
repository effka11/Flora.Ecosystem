# Flora Gov (Next.js)

Отдельный shell гражданского портала Flora (`gov.flora-s.net`). Это **другой origin**, чем Flora Social (`Apps/Web`, порт 3000): Gov не импортирует Web и не разделяет с ним UI.

Браузер ходит только на Next (`:3001`); Next проксирует `/api/auth/*` и `/api/messaging/*` на `flora-api`. Регистрация остаётся в Social на http://localhost:3000.

## Локально

`Apps/Gov` **не** входит в root npm workspaces — нужен свой `npm install` / `npm ci` в этом каталоге (свой `package-lock.json`).

В Cursor/VS Code: задача **Flora Government: Web Dev** (`Scripts/gov-dev-localhost.ps1`) — поднимает API если его нет, не трогает Social на `:3000`.

```bash
cd Apps/Gov
npm install
cp .env.example .env.local
npm run dev
```

Откройте http://localhost:3001 — редирект на `/login`.

Нужен запущенный **`flora-api`** на `http://127.0.0.1:5290`. Переменная `FLORA_API_UPSTREAM` задаётся из `.env.example` (по умолчанию тот же адрес).

## Право модерировать

Это не колонка в Auth. Спека franking держит roster в Messaging: таблица `flora_core.franking_reviewers`, активен тот, у кого `revoked_at IS NULL`. Очередь `/api/messaging/franking/queue` без этой роли отвечает 403 (`Нужна роль franking-ревьюера.`). Хост может дополнительно смержить UUID в ту же таблицу при старте (`Messaging:FrankingReviewerUserUuids`).

Схема появляется миграцией Messaging `20260816120000_franking_reports`. Из корня репозитория:

```powershell
cargo run -p flora-migrate -- --connection "<ConnectionStrings:FloraDatabase из Backend/appsettings.json>"
pwsh ./Scripts/grant-franking-reviewer.ps1 -Username egor
```

Перезапуск API после SQL-upsert не нужен. Другой аккаунт: тот же скрипт с его `-Username`. Снять роль: `-Revoke`. Список: `-List`.

## Прод

Хост: `gov.flora-s.net` (Cloudflare orange, как `social.*`). nginx vhost (прокси на `:3001`) поднимает `Apps/Web/scripts/remote-bootstrap-flora-web.sh` вместе с Social. CORS `https://gov.flora-s.net` пишет тот же bootstrap в `flora-api-cors.env`. Сборка/systemd самого Next Gov — отдельный деплой (`flora-gov` на порту 3001). Пока процесса нет, origin отвечает 502. Подключение = выкатить standalone на `:3001`; DNS/CDN уже готовы.

CSP в этом срезе **не** выставляется: неверный CSP ломает HMR Next в dev. Follow-up перед открытым продом Gov.

## Сборка

```bash
npm run build
npm start
```

Прод-слушатель: порт **3001**. Каталог standalone: `.next/standalone`.
