#!/bin/bash
# Run on the VPS as root after Let's Encrypt for origin.<DOMAIN> exists.
# Fixes: browser sees CN=www... when opening https://origin.<DOMAIN> (wrong SNI / default SSL vhost).
# Usage: DOMAIN=flora-s.net bash scripts/fix-origin-nginx-ssl.sh
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN=your-apex e.g. flora-s.net}"

ORIGIN_CERT="/etc/letsencrypt/live/origin.${DOMAIN}/fullchain.pem"
ORIGIN_KEY="/etc/letsencrypt/live/origin.${DOMAIN}/privkey.pem"

if [[ ! -f "$ORIGIN_CERT" || ! -f "$ORIGIN_KEY" ]]; then
  echo "Missing LE files: $ORIGIN_CERT or $ORIGIN_KEY" >&2
  exit 1
fi

{
  echo 'server {'
  echo '    listen 443 ssl;'
  echo "    server_name origin.${DOMAIN};"
  echo "    ssl_certificate ${ORIGIN_CERT};"
  echo "    ssl_certificate_key ${ORIGIN_KEY};"
  echo
  echo '    location / {'
  echo '        proxy_pass http://127.0.0.1:3000;'
  echo '        proxy_http_version 1.1;'
  echo '        proxy_set_header Host $host;'
  echo '        proxy_set_header X-Real-IP $remote_addr;'
  echo '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  echo '        proxy_set_header X-Forwarded-Proto $scheme;'
  echo '    }'
  echo '}'
} >/etc/nginx/sites-available/flora-origin-https.conf

ln -sf /etc/nginx/sites-available/flora-origin-https.conf /etc/nginx/sites-enabled/01-flora-origin-https.conf
nginx -t
systemctl reload nginx

echo "OK: https://origin.${DOMAIN}/ should now present the origin.* certificate (check: openssl s_client -connect origin.${DOMAIN}:443 -servername origin.${DOMAIN} </dev/null 2>/dev/null | openssl x509 -noout -subject)"
