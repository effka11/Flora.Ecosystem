# Flora Gov (Next.js)

Отдельный shell гражданского портала Flora (`gov.flora-s.net` в будущем). Это **другой origin**, чем Flora Social (`Apps/Web`, порт 3000): Gov не импортирует Web и не разделяет с ним UI.

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

## Content-Security-Policy

Заголовки CSP в этом срезе **не** выставляются: неверный CSP ломает HMR Next в dev. Это follow-up перед продом.

## Сборка

```bash
npm run build
npm start
```

Прод-слушатель: порт **3001**. Каталог standalone: `.next/standalone`.

## Будущее (вне этого среза)

Прод: `server_name gov.flora-s.net`, nginx, TLS — вне скоупа этого каркаса.
