#!/bin/bash
set -euo pipefail
ENV=/etc/flora-ecosystem/flora-api.env
TOKEN=$(openssl rand -hex 32)
{
  grep '^ConnectionStrings__' "$ENV" | head -1
  grep '^Jwt__' "$ENV"
  grep '^Smtp__' "$ENV"
  grep '^Push__' "$ENV"
  printf 'Flora__AdminBroadcastToken=%s\n' "$TOKEN"
} > /tmp/flora-api.env.clean
mv /tmp/flora-api.env.clean "$ENV"
chmod 600 "$ENV"
printf '%s' "$TOKEN" >/root/flora-broadcast-token-once.txt
chmod 600 /root/flora-broadcast-token-once.txt
systemctl daemon-reload
systemctl restart flora-api
sleep 4
PID=$(pgrep -xo Flora.API)
PROC=$(tr '\0' '\n' </proc/"$PID"/environ | grep -a '^Flora__AdminBroadcastToken=' | cut -d= -f2- || true)
echo "proc_len=${#PROC}"
FILE=$(grep '^Flora__AdminBroadcastToken=' "$ENV" | cut -d= -f2-)
echo "file_len=${#FILE}"
if [ "$FILE" = "$PROC" ]; then echo TOKEN_IN_PROC_OK; else echo TOKEN_IN_PROC_FAIL; fi
/tmp/probe-broadcast-api.sh
