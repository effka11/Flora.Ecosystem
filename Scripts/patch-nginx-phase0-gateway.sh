#!/bin/bash
# Flip nginx API upstream from .NET :5000 to Rust gateway :5290 (Phase 0).
# Rollback: sed 5290 -> 5000 and nginx -t && systemctl reload nginx
set -euo pipefail

TARGET="${1:-5290}"
FROM=5000
if [[ "$TARGET" == "5000" ]]; then
  FROM=5290
fi

files=(
  /etc/nginx/sites-available/flora-web.conf
  /etc/nginx/sites-available/flora-origin-https.conf
  /etc/nginx/sites-enabled/00-flora-web.conf
  /etc/nginx/sites-enabled/01-flora-origin-https.conf
)

changed=0
for f in "${files[@]}"; do
  if [[ -f "$f" ]] && grep -q "127.0.0.1:${FROM}" "$f"; then
    cp -a "$f" "${f}.bak.phase0.$(date +%s)"
    sed -i "s|127.0.0.1:${FROM}|127.0.0.1:${TARGET}|g" "$f"
    echo "patched $f -> :${TARGET}"
    changed=1
  fi
done

if [[ "$changed" -eq 0 ]]; then
  echo "no files needed patching (already on :${TARGET}?)" >&2
fi

nginx -t
systemctl reload nginx
echo "nginx reloaded; API upstream -> 127.0.0.1:${TARGET}"
curl -fsSI https://origin.flora-s.net/health 2>/dev/null | head -n 5 || curl -fsS http://127.0.0.1/health -H 'Host: origin.flora-s.net' || true
