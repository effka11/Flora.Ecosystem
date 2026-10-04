#!/usr/bin/env bash
# One-shot: add /apk/ static channel to existing flora-web nginx vhosts.
# Run on VPS as root after scp, or via: ssh … 'bash -s' < patch-nginx-apk-channel.sh
set -euo pipefail

mkdir -p /var/www/flora-apk

block='    # Flora Social Android APK channel (static; bypass Next).
    location = /apk/releases.json {
        alias /var/www/flora-apk/releases.json;
        default_type application/json;
        add_header Cache-Control "no-store" always;
    }
    location = /apk/flora.social-android-update.json {
        alias /var/www/flora-apk/flora.social-android-update.json;
        default_type application/json;
        add_header Cache-Control "no-store" always;
    }
    location /apk/ {
        alias /var/www/flora-apk/;
        types { application/vnd.android.package-archive apk; }
        default_type application/octet-stream;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }
'

for name in flora-origin-https.conf flora-web.conf; do
  f="/etc/nginx/sites-available/$name"
  [[ -f "$f" ]] || continue
  if grep -q 'location /apk/' "$f"; then
    echo "skip $name (already patched)"
    continue
  fi
  python3 - "$f" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
block = """    # Flora Social Android APK channel (static; bypass Next).
    location = /apk/releases.json {
        alias /var/www/flora-apk/releases.json;
        default_type application/json;
        add_header Cache-Control "no-store" always;
    }
    location = /apk/flora.social-android-update.json {
        alias /var/www/flora-apk/flora.social-android-update.json;
        default_type application/json;
        add_header Cache-Control "no-store" always;
    }
    location /apk/ {
        alias /var/www/flora-apk/;
        types { application/vnd.android.package-archive apk; }
        default_type application/octet-stream;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
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
echo "nginx APK channel patch OK"
