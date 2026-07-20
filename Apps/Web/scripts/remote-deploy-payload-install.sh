#!/bin/bash
# Runs on the server inside the extracted payload directory (alongside bootstrap.sh, args.txt, web/).
# Phase 5: web-only payload; Rust flora-api is deployed separately (not via this tarball).
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

if [ -d "$HERE/api" ]; then
  echo "Ignoring legacy api/ payload (C# Flora.API removed in Phase 5)." >&2
fi

systemctl stop flora-web || true
BAK="${REMOTE_PATH}.bak.${TS}"
if [ -d "$REMOTE_PATH" ]; then
  mv "$REMOTE_PATH" "$BAK"
fi
mkdir -p "$REMOTE_PATH"
cp -a web/. "$REMOTE_PATH/"
# Keep deployed code immutable to the runtime identity. Next may only write its cache.
chown -R root:flora-web "$REMOTE_PATH"
find "$REMOTE_PATH" -type d -exec chmod 750 {} +
find "$REMOTE_PATH" -type f -exec chmod 640 {} +
mkdir -p "$REMOTE_PATH/.next/cache"
chown -R flora-web:flora-web "$REMOTE_PATH/.next/cache"
chmod 750 "$REMOTE_PATH/.next/cache"

systemctl start flora-web
sleep 1
systemctl is-active flora-web

cd /
rm -rf "/tmp/flora-d-${TS}"
