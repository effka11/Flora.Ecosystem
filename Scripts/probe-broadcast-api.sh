#!/bin/bash
set -euo pipefail
printf '%s' '{"text":"probe"}' >/tmp/broadcast-probe.json
PID=$(pgrep -xo Flora.API)
TOKEN=$(tr '\0' '\n' </proc/"$PID"/environ | grep -a '^Flora__AdminBroadcastToken=' | cut -d= -f2-)
echo "token_len=${#TOKEN}"
echo "wrong token:"
curl -s -w "\nHTTP:%{http_code}\n" -X POST http://127.0.0.1:5000/api/admin/notifications/broadcast \
  -H 'Content-Type: application/json; charset=utf-8' \
  -H 'X-Flora-Admin-Token: wrong' \
  --data-binary @/tmp/broadcast-probe.json
echo "valid token:"
curl -s -w "\nHTTP:%{http_code}\n" -X POST http://127.0.0.1:5000/api/admin/notifications/broadcast \
  -H 'Content-Type: application/json; charset=utf-8' \
  -H "X-Flora-Admin-Token: $TOKEN" \
  --data-binary @/tmp/broadcast-probe.json
