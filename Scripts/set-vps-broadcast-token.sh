#!/bin/bash
set -euo pipefail
TOKEN=$(openssl rand -hex 32)
grep -v '^Flora__AdminBroadcastToken=' /etc/flora-ecosystem/flora-api.env \
  | grep -v '^n#$' \
  | grep -v 'App-update broadcast' \
  > /tmp/flora-api.env.new
printf 'Flora__AdminBroadcastToken=%s\n' "$TOKEN" >> /tmp/flora-api.env.new
mv /tmp/flora-api.env.new /etc/flora-ecosystem/flora-api.env
chmod 600 /etc/flora-ecosystem/flora-api.env
printf '%s' "$TOKEN" >/root/flora-broadcast-token-once.txt
chmod 600 /root/flora-broadcast-token-once.txt
# Phase 0+: token consumed by .NET upstream; restart both units if present.
systemctl restart flora-api-dotnet 2>/dev/null || systemctl restart flora-api
systemctl try-restart flora-api 2>/dev/null || true
sleep 3
/tmp/probe-broadcast-api.sh
