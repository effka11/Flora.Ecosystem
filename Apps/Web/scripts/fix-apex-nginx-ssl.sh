#!/bin/bash
# Apex/www HTTPS: flora-s.net Www shell (Apps/Www). www → https://apex.
# Usage: DOMAIN=flora-s.net PUBLIC_SUBDOMAIN=social CERTBOT_EMAIL=you@mail.com bash scripts/fix-apex-nginx-ssl.sh
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN=your-apex e.g. flora-s.net}"
PUBLIC_SUBDOMAIN="${PUBLIC_SUBDOMAIN:-social}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
SOCIAL_ORIGIN="https://${PUBLIC_SUBDOMAIN}.${DOMAIN}"
GOV_ORIGIN="https://gov.${DOMAIN}"

rm -f /etc/nginx/conf.d/flora-web.conf /etc/nginx/conf.d/default.conf || true
rm -f /etc/nginx/sites-enabled/00-flora-apex-site.conf /etc/nginx/sites-enabled/02-flora-apex-https.conf || true
rm -f /etc/nginx/sites-enabled/00-flora-apex-redirect.conf /etc/nginx/sites-enabled/02-flora-apex-https-redirect.conf || true

mkdir -p /var/www/certbot /var/www/flora-www

if [[ ! -f /var/www/flora-www/health.json ]]; then
  printf '{"status":"healthy","service":"%s"}\n' "$DOMAIN" >/var/www/flora-www/health.json
fi
if [[ ! -f /var/www/flora-www/index.html ]]; then
  printf '%s\n' "<!doctype html><title>Flora</title><p>Flora</p><p><a href=\"${SOCIAL_ORIGIN}\">Social</a></p><p><a href=\"${GOV_ORIGIN}\">Gov</a></p>" >/var/www/flora-www/index.html
fi

if ! command -v certbot >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y certbot
fi

# Delete apex AAAA in DNS before running (LE validates IPv6; stale AAAA → certbot fails).
CERTBOT_ARGS=(certonly --webroot -w /var/www/certbot -d "${DOMAIN}" -d "www.${DOMAIN}" --non-interactive --agree-tos --cert-name "${DOMAIN}" --expand --keep-until-expiring)
if [[ -n "$CERTBOT_EMAIL" && "$CERTBOT_EMAIL" == *"@"* ]]; then
  CERTBOT_ARGS+=(-m "$CERTBOT_EMAIL")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi
certbot "${CERTBOT_ARGS[@]}"

APEX_CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
APEX_KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
if [[ ! -f "$APEX_CERT" || ! -f "$APEX_KEY" ]]; then
  echo "Let's Encrypt cert missing after certbot." >&2
  exit 1
fi

{
  echo 'server {'
  echo '    listen 443 ssl;'
  echo "    server_name ${DOMAIN};"
  echo "    ssl_certificate ${APEX_CERT};"
  echo "    ssl_certificate_key ${APEX_KEY};"
  echo
  echo '    location = /health {'
  echo '        alias /var/www/flora-www/health.json;'
  echo '        default_type application/json;'
  echo '        add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;'
  echo '        add_header Pragma "no-cache" always;'
  echo '    }'
  echo '    location / {'
  echo '        root /var/www/flora-www;'
  echo '        index index.html;'
  echo '        add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;'
  echo '    }'
    echo '}'
    echo
    echo 'server {'
    echo '    listen 443 ssl;'
    echo "    server_name www.${DOMAIN};"
    echo "    ssl_certificate ${APEX_CERT};"
    echo "    ssl_certificate_key ${APEX_KEY};"
    echo "    return 301 https://${DOMAIN}\$request_uri;"
    echo '}'
} >/etc/nginx/sites-available/flora-apex-https.conf

ln -sf /etc/nginx/sites-available/flora-apex-https.conf /etc/nginx/sites-enabled/02-flora-apex-https.conf
nginx -t
systemctl reload nginx

echo "OK: https://${DOMAIN}/ (Www shell), https://www.${DOMAIN}/ → apex, https://${DOMAIN}/health"
