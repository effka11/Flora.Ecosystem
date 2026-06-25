#!/bin/bash
set -euo pipefail
CONF="${1:-/etc/nginx/sites-available/flora-origin-https.conf}"
if grep -q 'location /api/admin/' "$CONF"; then
  echo "nginx admin proxy already present"
  exit 0
fi
cp "$CONF" "${CONF}.bak.$(date +%s)"
python3 - <<'PY'
from pathlib import Path
p = Path("/etc/nginx/sites-available/flora-origin-https.conf")
text = p.read_text()
block = """    location /api/admin/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 1m;
    }

"""
needle = "    location = /api/auth/signals/stream {"
if "location /api/admin/" not in text:
    if needle not in text:
        raise SystemExit("needle not found in nginx config")
    p.write_text(text.replace(needle, block + needle))
    print("patched")
PY
nginx -t
systemctl reload nginx
echo "nginx reloaded"
