#!/bin/bash
# Runs on the server inside the extracted payload directory (alongside bootstrap.sh, args.txt, web/, api/).
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo env "TS=${TS:-}" bash "$0" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

chmod 700 bootstrap.sh
bash bootstrap.sh args.txt

REMOTE_PATH="$(sed -n '1p' args.txt)"
TS="${TS:?missing TS}"

API_REMOTE="/opt/flora-ecosystem/runtime/api"

if [ -d "$HERE/api" ] && [ -f "$HERE/api/Flora.API" ]; then
  systemctl stop flora-api 2>/dev/null || true
  BAK_API="${API_REMOTE}.bak.${TS}"
  if [ -d "$API_REMOTE" ]; then
    rm -rf "$BAK_API" || true
    mv "$API_REMOTE" "$BAK_API"
  fi
  mkdir -p "$API_REMOTE"
  cp -a "$HERE/api/." "$API_REMOTE/"
  chmod 755 "$API_REMOTE"
  chmod +x "$API_REMOTE/Flora.API" || true
  rm -f "$API_REMOTE/appsettings.Local.json"
  systemctl daemon-reload
  systemctl enable flora-api >/dev/null 2>&1 || true
  systemctl restart flora-api
  sleep 2
  systemctl is-active flora-api || {
    echo "flora-api failed to start. Logs: journalctl -u flora-api -n 50 --no-pager" >&2
    exit 1
  }
fi

systemctl stop flora-web || true
BAK="${REMOTE_PATH}.bak.${TS}"
if [ -d "$REMOTE_PATH" ]; then
  mv "$REMOTE_PATH" "$BAK"
fi
mkdir -p "$REMOTE_PATH"
cp -a web/. "$REMOTE_PATH/"
chmod 755 "$REMOTE_PATH"

systemctl start flora-web
sleep 1
systemctl is-active flora-web

cd /
rm -rf "/tmp/flora-d-${TS}"
