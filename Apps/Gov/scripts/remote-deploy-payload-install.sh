#!/bin/bash
# Runs on the server inside the extracted payload directory (alongside bootstrap.sh, args.txt, gov/).
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo env "TS=${TS:-}" bash "$0" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

chmod 700 bootstrap.sh
bash bootstrap.sh args.txt

REMOTE_PATH="$(sed -n '1p' args.txt | tr -d '\r')"
TS="${TS:?missing TS}"

systemctl stop flora-gov || true
BAK="${REMOTE_PATH}.bak.${TS}"
if [ -d "$REMOTE_PATH" ]; then
  mv "$REMOTE_PATH" "$BAK"
fi
mkdir -p "$REMOTE_PATH"
cp -a gov/. "$REMOTE_PATH/"
chown -R root:flora-gov "$REMOTE_PATH"
find "$REMOTE_PATH" -type d -exec chmod 750 {} +
find "$REMOTE_PATH" -type f -exec chmod 640 {} +

if [ -f "$REMOTE_PATH/server.js" ]; then
  GOV_WORKDIR="$REMOTE_PATH"
elif [ -f "$REMOTE_PATH/Apps/Gov/server.js" ]; then
  GOV_WORKDIR="$REMOTE_PATH/Apps/Gov"
else
  echo "server.js missing under $REMOTE_PATH (expected root or Apps/Gov)." >&2
  exit 1
fi

mkdir -p "$GOV_WORKDIR/.next/cache"
chown -R flora-gov:flora-gov "$GOV_WORKDIR/.next/cache"
chmod 750 "$GOV_WORKDIR/.next/cache"

mkdir -p /etc/systemd/system/flora-gov.service.d
{
  printf '%s\n' '[Service]'
  printf 'WorkingDirectory=%s\n' "$GOV_WORKDIR"
  printf 'ReadWritePaths=%s/.next/cache\n' "$GOV_WORKDIR"
} >/etc/systemd/system/flora-gov.service.d/60-workdir.conf
systemctl daemon-reload

systemctl start flora-gov
active=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if systemctl is-active --quiet flora-gov; then
    active=1
    break
  fi
  sleep 1
done
if [[ "$active" -ne 1 ]]; then
  journalctl -u flora-gov -n 60 --no-pager >&2 || true
  systemctl is-active flora-gov
  exit 1
fi
systemctl is-active flora-gov

cd /
rm -rf "/tmp/flora-d-${TS}"
