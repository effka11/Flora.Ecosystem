#!/usr/bin/env bash
set -euo pipefail

block='    location = /api/auth/signals/stream {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
'

for name in flora-origin-https.conf flora-web.conf; do
  f="/etc/nginx/sites-available/$name"
  [[ -f "$f" ]] || continue
  if grep -q 'signals/stream' "$f"; then
    echo "skip $name (already patched)"
    continue
  fi
  python3 - "$f" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
block = """    location = /api/auth/signals/stream {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
"""
marker = "    location / {"
if marker not in text:
    raise SystemExit(f"marker not found in {path}")
path.write_text(text.replace(marker, block + marker, 1))
print("patched", path.name)
PY
done

nginx -t
systemctl reload nginx
echo "nginx SSE patch OK"
