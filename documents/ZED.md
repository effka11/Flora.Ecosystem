# Zed — Flora.Ecosystem

Onboarding для Zed Agent и внешних агентов (ACP). Общие правила репозитория — [`AGENTS.md`](../AGENTS.md) в корне. На Windows это тот же файл, что `agents.md`.

## Куда попали правила

| Источник в Cursor | Куда смотрит Zed |
|-------------------|------------------|
| `AGENTS.md` | Всегда, как project instructions. Личный файл `%APPDATA%\Zed\AGENTS.md` его не перебивает: при конфликте побеждает проект. |
| `.cursor/rules/flora-ui-dash-separator.mdc` | Тот же запрет в `AGENTS.md` (раздел apps/Web). У Zed нет glob-rules; отдельный `.rules` не создавать — он заменит `AGENTS.md` целиком. |
| Пользовательские правила Cursor (коммиты, PR, проверка UI) | `%APPDATA%\Zed\AGENTS.md`. Claude ACP читает `%USERPROFILE%\.claude\CLAUDE.md`, не личный файл Zed. |
| `.cursorignore` + `.cursor/hooks` | В Zed хуков нет. Секреты скрыты из индекса (`file_scan_exclusions`) и запрещены к правке в user `tool_permissions`. Это слабее Cursor: известный путь агент всё ещё может прочитать. Не открывать `local/.flora`, `*.secret`, `.env`, `backend/secrets`. |

Skills Zed берёт из `.agents/skills/` (проект) и `%USERPROFILE%\.agents\skills\` (глобально). Проектный skill с тем же именем важнее.

## Agent Panel

| Профиль | Когда |
|---------|--------|
| **Write** (default) | Реализация, рефакторинг |
| **Ask** | Вопросы без правок |
| **Minimal** | Без tools |

`single_file_review` включён: diff перед accept. Панель: `Ctrl+Shift+A`. Tasks: `Ctrl+Shift+T`.

Модель по умолчанию задаётся в user settings (OpenRouter). Профили агента в `.zed/settings.json` не работают — только в user settings.

## Skills

| Skill | Когда |
|-------|--------|
| `/apps-web-grid-placement` | `top` / margin / absolute в `apps/Web` |
| `/apps-web-messages-chat` | Чат Messages, голос, стикеры |
| `/flora-fscp-e2e` | FSCP wire, эпохи, backup, franking, группы |
| `/flora-plan-reviewer`, `/flora-plan-reviser` | План работы |
| `/flora-plan-router`, `/flora-plan-orchestrator` | Раздача плана по моделям и волны |
| `/flora-smart-agent-economy` | Сбор контекста отдельным субагентом |
| `/flora-code-reviewer`, `/flora-code-reviser` | Ревью git diff и закрытие дыр |
| `/diagnose`, `/review`, `/tdd`, `/babysit` | Глобальные, `%USERPROFILE%\.agents\skills` |

Перед первым агентским тредом в этом клоне: Command Palette → доверить проект (project trust). Иначе project skills не попадают в каталог.

## Tasks

`Ctrl+Shift+T`.

**Один клик:** `Flora: API + Web dev localhost (Zed)` — DB + Rust `flora-api` `:5290` + Web (`scripts/zed-dev-api-web.ps1`).

**По шагам:**

1. `Flora DB: start (Docker)`
2. `Flora API: Rust localhost` (`:5290`, тот же скрипт, что `Flora API: dev localhost`)
3. `Flora: dev localhost` (Web, proxy → `:5290`)

Jwt и franking seed скрипт поднимает сам (`scripts/ensure-shared-dev-jwt.ps1`, `ensure-franking-signing-seed.ps1`). Агент эти файлы не читает.

**Проверки:** `cargo fmt --check`, `cargo clippy (workspace, -D warnings)`, `cargo test (workspace)`, `cargo deny check`, `Flora: validate architecture (Rust)`, `npm: typecheck`, `npm: lint`, `npm: ci`.

## Редактор

`.zed/settings.json`:

- Индекс без `target/`, `.next`, `node_modules` и каталогов секретов.
- rust-analyzer: clippy **текущего пакета** (`check.workspace: false`), отдельный `target/rust-analyzer`.
- `rustfmt` при сохранении Rust-файлов.

Полный `cargo clippy --workspace` на каждое сохранение здесь не запускается — он в task.

## Debugger

`F4` → `flora-api: debug` (CodeLLDB, встроенный адаптер Rust). Сборка: `cargo build -p flora-api`.

В `.zed/debug.json` нет `Jwt__Secret` и `Messaging__FrankingSigningSeed`. Перед сессией экспортни их в окружение процесса Zed командами ensure-скриптов у себя в терминале и не вставляй значения в json. Без этих двух переменных процесс не поднимется. Слушатель и `*__ServeNative` в конфиге уже стоят, порт `127.0.0.1:5290`.

## MCP

Глобально (user settings): context7, chunkhound, git, playwright, github. Postgres/redis/docker в тех же settings — контур Luna, не Flora. База Flora — `docker compose` и task `Flora DB`.

Песочница агента: сеть по allowlist (GitHub, crates.io, docs.rs, npm, zed.dev, localhost). Новый хост — через prompt. `allow_all_hosts` не включать.

## ACP (внешние агенты)

Agent Panel → **+** → Install from Registry (`zed: acp registry`):

| Агент | Правила, которые он реально читает |
|-------|--------------------------------------|
| Claude | `~/.claude/CLAUDE.md` + project `AGENTS.md`. Billing отдельно, `/login`. |
| Cursor | Правила аккаунта Cursor + project `AGENTS.md`. |
| Codex | Свой конфиг + project `AGENTS.md`, если агент его подхватывает. |

Профили и skills Zed на внешний агент не действуют. MCP из user settings могут пробрасываться.

## Проверка после правок

`cargo test -p <crate>` и clippy затронутого крейта; для TS — `npm run typecheck`. Полный прогон — tasks выше.

## Smoke-test

1. Agent Panel → Settings → MCP зелёные (context7, chunkhound).
2. `/` в треде показывает `apps-web-*` и `flora-*` из `.agents/skills`.
3. `Ctrl+Shift+T` → `cargo fmt --check`.
4. Открытый `.rs` не запускает clippy всего workspace (диагностика пакета).
