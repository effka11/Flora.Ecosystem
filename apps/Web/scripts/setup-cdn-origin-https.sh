#!/bin/bash
# HTTPS origin for Selectel CDN (pulls only :443). Run on VPS as root.
set -euo pipefail

DOMAIN="${DOMAIN:-flora-s.net}"
PUBLIC_SUBDOMAIN="${PUBLIC_SUBDOMAIN:-social}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y certbot
mkdir -p /var/www/certbot

if [ ! -f "/etc/letsencrypt/live/origin.${DOMAIN}/fullchain.pem" ]; then
  CB_ARGS=(certonly --webroot -w /var/www/certbot -d "origin.${DOMAIN}" --non-interactive --agree-tos --keep-until-expiring)
  if [[ -n "$CERTBOT_EMAIL" && "$CERTBOT_EMAIL" == *"@"* ]]; then
    CB_ARGS+=(-m "$CERTBOT_EMAIL")
  else
    CB_ARGS+=(--register-unsafely-without-email)
  fi
  certbot "${CB_ARGS[@]}"
fi

ORIGIN_CERT="/etc/letsencrypt/live/origin.${DOMAIN}/fullchain.pem"
ORIGIN_KEY="/etc/letsencrypt/live/origin.${DOMAIN}/privkey.pem"

cat > /etc/nginx/sites-available/flora-origin-https.conf <<EOF
server {
    listen 443 ssl;
    server_name origin.${DOMAIN} ${PUBLIC_SUBDOMAIN}.${DOMAIN};

    ssl_certificate ${ORIGIN_CERT};
    ssl_certificate_key ${ORIGIN_KEY};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/flora-origin-https.conf /etc/nginx/sites-enabled/01-flora-origin-https.conf
nginx -t
systemctl reload nginx

echo "OK: https://origin.${DOMAIN}/ (Host: ${PUBLIC_SUBDOMAIN}.${DOMAIN})"
curl -skI -H "Host: ${PUBLIC_SUBDOMAIN}.${DOMAIN}" "https://origin.${DOMAIN}/" | head -5
