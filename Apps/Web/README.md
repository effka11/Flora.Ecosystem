# Flora Web (Next.js)

Клиент для [Flora.API](https://github.com/effka11/Flora.Ecosystem/tree/main/Flora.API) — вход по телефону и паролю (`POST /api/auth/login`, `POST /api/auth/register` через прокси).

## Локально

```bash
cd Apps/Web
npm install
npm run dev
```

Откройте http://localhost:3000 — редирект на `/login`.

## IP whitelist (опциональное ограничение доступа по IP)

В `Apps/Web/middleware.ts` есть **опциональный** белый список IP на уровне Next.js. По умолчанию он **выключен** (сайт публичный) и **не содержит зашитых адресов** — список задаётся только через env.

### Включить (по умолчанию выключено)

```powershell
$env:FLORA_ENFORCE_IP_ALLOWLIST="1"
$env:FLORA_ALLOWED_IPS="203.0.113.10,198.51.100.7"
```

Linux / systemd (в unit-файле сервиса):

```ini
Environment=FLORA_ENFORCE_IP_ALLOWLIST=1
Environment=FLORA_ALLOWED_IPS=203.0.113.10,198.51.100.7
```

После изменения unit — `systemctl daemon-reload && systemctl restart flora-web` (имя сервиса может отличаться).

### Выключить (поведение по умолчанию)

```powershell
$env:FLORA_ENFORCE_IP_ALLOWLIST="0"
```

Если enforce включён, но `FLORA_ALLOWED_IPS` пуст — доступ закрыт для всех (fail-closed).

### Важно про прокси

Если перед Next стоит reverse proxy, он должен корректно проставлять **`X-Forwarded-For` / `X-Real-IP`**, иначе IP может определяться неверно.

## Сборка standalone (как на сервере)

```bash
npm run build
npm run prepare:standalone
```

Или одной командой: `npm run publish:build` (сборка + копирование `public` и `.next/static` в `.next/standalone`).

Готовый каталог для Node: **`.next/standalone`** (внутри — `server.js`, `node_modules`, `.next`).

На Linux после сборки то же делает `npm run prepare:standalone`.

## Публикация с вашей машины (Cursor / VS Code)

В репозитории: **[`.vscode/tasks.json`](../../.vscode/tasks.json)**.

Откройте в Cursor **корень репозитория `Flora.Ecosystem`** (папка с `Flora.API`, `Apps`, `.vscode`). Если открыта только `Apps/Web`, переменная `${workspaceFolder}` будет неверной и задачи не найдут скрипты.

Задачи вызывают **`powershell.exe`** (встроенный Windows PowerShell). Отдельный **PowerShell 7 (`pwsh`) не нужен**.

1. **Terminal → Run Task…** (или Command Palette: `Tasks: Run Task`).
2. Сначала запустите **«Flora Web: test (terminal)»** — должен открыться терминал и появиться строки `Flora task OK` и путь workspace. Если этого нет, проблема в окружении Cursor, а не в скриптах.
3. **«Flora Web: build (production standalone)»** — сборка через [`scripts/task-build.cmd`](scripts/task-build.cmd) (надёжнее, чем одна строка в shell).
4. **«Flora Web: publish to VPS (full)»** — запрос хоста и ключа, затем [`scripts/deploy.ps1`](scripts/deploy.ps1) (сборка + выгрузка). Пустой ключ → дефолт из `deploy.ps1`.
5. **«Flora Web: publish to VPS (upload only)»** — то же, но `-SkipBuild`.

Задачи объявлены как **`type: process`** (прямой запуск `cmd.exe` / `powershell.exe`), чтобы интегрированный терминал стабильно открывался в Cursor/VS Code на Windows.

## Деплой на сервер (standalone + systemd `flora-web`)

На хосте: Next на `127.0.0.1:3000`, Caddy отдаёт `flora-s.net` и проксирует `/api/*` на Flora.API.

Из Windows (пути и ключ подставьте свои):

```powershell
cd Apps/Web
.\scripts\deploy.ps1 -Server <your-server-ip> -IdentityFile "$env:USERPROFILE\.ssh\id_ed25519_flora"
```

Скрипт делает `next build`, копирует `public` и `.next/static` в `standalone`, останавливает сервис, бэкапит каталог, заливает файлы **включая скрытую папку `.next`** (одного `scp *` недостаточно), запускает `flora-web`.

Проверка на сервере: `curl -sI http://127.0.0.1:3000/` — ожидается `307` с `location: /login`.
