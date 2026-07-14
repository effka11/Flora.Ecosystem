# Zed — Flora.Ecosystem

Краткий onboarding для Zed + AI Agent. Cursor: `.vscode/tasks.json`; Zed: `.zed/tasks.json`.

## Agent Panel

| Профиль | Когда |
|---------|--------|
| **Write** (default) | Реализация, рефакторинг |
| **Ask** | Вопросы без правок |
| **Minimal** | Общие вопросы |

Правила: **`AGENTS.md`** + `%APPDATA%\Zed\AGENTS.md`. Diff-ревью перед accept включён.

## Skills

| Skill | Когда |
|-------|--------|
| `/apps-web-grid-placement` | Правки `top`/margin/absolute в `Apps/Web` |
| `/apps-web-messages-chat` | Чат Messages, голос, стикеры |
| `/flora-fscp-e2e` | FSCP wire + E2E security, Flora.Messaging |
| `/diagnose`, `/review`, `/tdd` | Глобальные |

Project skills: `.agents/skills/`.

## Tasks

`Ctrl+Shift+T` — task picker.

**Один клик (Zed):** `Flora: API + Web dev localhost (Zed)` — DB + .NET `:5284` + Rust gateway `:5290` + Web.

**Cursor:** `Flora: API + Web dev (script)` — тот же `Scripts/zed-dev-api-web.ps1`.

**По шагам** (Cursor `dependsOn` или ручной запуск):

1. `Flora DB: start (Docker)`
2. `Flora API: .NET upstream localhost` (`:5284`)
3. `Flora Gateway: Rust localhost` (`:5290`)
4. `Flora Web: dev localhost` (proxy → `:5290`)

Общий Jwt: `.flora/dev-jwt.secret` (`Scripts/ensure-shared-dev-jwt.ps1`). Music workers только на gateway (`Music:ServeNative`).

## Debugger

`F4` / **debugger: start** — `Flora.API: debug`.

**Требования:**
- C# extension (`csharp` в `auto_install_extensions`)
- netcoredbg — extension скачивает при первом debug session

**Конфиг:** `.zed/debug.json` — `program` с `{targetFramework}` → **net10.0** для Flora.API.

Smoke-test: breakpoint в startup Flora.API, `F4` → `Flora.API: debug`.

**Если adapter не виден:** Command Palette → `dev: copy debug adapter arguments` — диагностика DAP.

## MCP

Глобальные (user settings): context7, memory, sequential-thinking, github. Postgres/redis/docker — Luna.Quant.

## ACP (Claude Agent)

Agent Panel → **+** → Claude Agent (ACP Registry) → `/login`. Отдельный billing от Zed Agent. См. `%APPDATA%\Zed\docs\ZED-GLOBAL.md`.

## Проверка после правок

`dotnet build`, `npm run typecheck`, `npm run ci`.

## Smoke-test Zed

1. Agent Panel → Settings → MCP зелёные
2. Extension `csharp` установлен
3. `F4` → `Flora.API: debug` — breakpoint на `:5284`
4. `/` → `apps-web-*` skills видны

Pre-commit (`.pre-commit-config.yaml`) — опционально, user-managed.
