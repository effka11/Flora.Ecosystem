#!/bin/bash
# Apex/www HTTPS redirect to social.<DOMAIN> (Let's Encrypt on VPS for redirect only).
# Usage: DOMAIN=flora-s.net PUBLIC_SUBDOMAIN=social CERTBOT_EMAIL=you@mail.com bash scripts/fix-apex-nginx-ssl.sh
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN=your-apex e.g. flora-s.net}"
PUBLIC_SUBDOMAIN="${PUBLIC_SUBDOMAIN:-social}"CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

rm -f /etc/nginx/conf.d/flora-web.conf /etc/nginx/conf.d/default.conf || true
rm -f /etc/nginx/sites-enabled/00-flora-apex-site.conf /etc/nginx/sites-enabled/02-flora-apex-https.conf || true

mkdir -p /var/www/certbot

if ! command -v certbot >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y certbot
fi

# Delete apex AAAA in DNS before running (LE validates IPv6; stale AAAA → certbot fails).
CERTBOT_ARGS=(certonly --webroot -w /var/www/certbot -d "${DOMAIN}" --non-interactive --agree-tos --cert-name "${DOMAIN}" --keep-until-expiring)
if [[ -n "$CERTBOT_EMAIL" && "$CERTBOT_EMAIL" == *"@"* ]]; then
  CERTBOT_ARGS+=(-m "$CERTBOT_EMAIL")
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
  echo "    server_name ${DOMAIN} www.${DOMAIN};"
  echo "    ssl_certificate ${APEX_CERT};"
  echo "    ssl_certificate_key ${APEX_KEY};"
  echo
  echo "    return 301 https://${PUBLIC_SUBDOMAIN}.${DOMAIN}\$request_uri;"  echo '}'
} >/etc/nginx/sites-available/flora-apex-https-redirect.conf

ln -sf /etc/nginx/sites-available/flora-apex-https-redirect.conf /etc/nginx/sites-enabled/02-flora-apex-https-redirect.conf
nginx -t
systemctl reload nginx

echo "OK: https://${DOMAIN}/ and https://www.${DOMAIN}/ redirect to https://${PUBLIC_SUBDOMAIN}.${DOMAIN}/"