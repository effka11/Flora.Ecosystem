# Flora Www (apex)

Публичный шелл экосистемы на **`flora-s.net`**. Отдельный origin от Social (`social.*`, `Apps/Web`) и Gov (`gov.*`, `Apps/Gov`): без Next, без импорта Web/Gov, без бизнес-логики.

Пока это статика:

- `GET /` — короткая страница со ссылками на Social и Gov
- `GET /health` — `{"status":"healthy","service":"flora-s.net"}`

Плейсхолдеры `__DOMAIN__`, `__SOCIAL_ORIGIN__`, `__GOV_ORIGIN__` подставляет nginx-bootstrap на VPS.

Прод: `server_name flora-s.net`, root `/var/www/flora-www`. `www.flora-s.net` → 301 на apex. Катится вместе с `Apps/Web/scripts/deploy.ps1` (каталог `www/` в payload).
