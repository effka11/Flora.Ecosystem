#!/bin/bash
# Usage: bash /tmp/remote-bootstrap-flora-web.sh /tmp/flora-args.txt
# Arg file: line 1 REMOTE_PATH, 2 DOMAIN, 3 API_UPSTREAM, 4 CERTBOT_EMAIL (optional),
# 5 ALLOWED_CLIENT_IPS (optional), 6 PUBLIC_SUBDOMAIN (optional, default social — CDN site host),
# 7 WEB_BUILD_ID (optional — CDN cache-bust ?b= without panel purge).
set -euo pipefail

ARGS_FILE="${1:?path to args file}"

REMOTE_PATH="$(sed -n '1p' "$ARGS_FILE")"
DOMAIN="$(sed -n '2p' "$ARGS_FILE")"
API_UPSTREAM="$(sed -n '3p' "$ARGS_FILE")"
CERTBOT_EMAIL="$(sed -n '4p' "$ARGS_FILE" | tr -d '\r' || true)"
CERTBOT_EMAIL="${CERTBOT_EMAIL//[[:space:]]/}"
ALLOWED_CLIENT_IPS="$(sed -n '5p' "$ARGS_FILE" | tr -d '\r' || true)"
ALLOWED_CLIENT_IPS="${ALLOWED_CLIENT_IPS//[[:space:]]/}"
PUBLIC_SUBDOMAIN="$(sed -n '6p' "$ARGS_FILE" | tr -d '\r' || true)"
PUBLIC_SUBDOMAIN="${PUBLIC_SUBDOMAIN//[[:space:]]/}"
PUBLIC_SUBDOMAIN="${PUBLIC_SUBDOMAIN:-social}"
WEB_BUILD_ID="$(sed -n '7p' "$ARGS_FILE" | tr -d '\r' || true)"
WEB_BUILD_ID="${WEB_BUILD_ID//[[:space:]]/}"

if [[ -z "$REMOTE_PATH" || -z "$DOMAIN" ]]; then
  echo "ARGS file must define REMOTE_PATH and DOMAIN on lines 1 and 2." >&2
  exit 1
fi

[[ -z "$API_UPSTREAM" ]] && API_UPSTREAM='http://127.0.0.1:5000'

if ! command -v node >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    echo "Node.js is missing and apt-get is unavailable. Install Node.js manually." >&2
    exit 1
  fi
fi

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  export NEEDRESTART_MODE=a
  yes N | dpkg --configure -a 2>/dev/null || true
  if ! command -v nginx >/dev/null 2>&1; then
    apt-get install -y \
      -o Dpkg::Options::="--force-confdef" \
      -o Dpkg::Options::="--force-confold" \
      nginx
  fi
fi

mkdir -p "$REMOTE_PATH"
chmod 755 "$REMOTE_PATH"

mkdir -p /etc/flora-ecosystem
if [ ! -f /etc/flora-ecosystem/flora-api.env.example ]; then
  {
    echo '# sudo cp /etc/flora-ecosystem/flora-api.env.example /etc/flora-ecosystem/flora-api.env && sudo chmod 600 /etc/flora-ecosystem/flora-api.env'
    echo 'ConnectionStrings__FloraDatabase=Host=127.0.0.1;Port=5432;Database=flora_social;Username=flora;Password=CHANGE_ME;Include Error Detail=true;Search Path=flora_core'
    echo '# Optional debug (remove after fix): ASPNETCORE_DETAILED_ERRORS=1'
    echo '# SMTP (Gmail app password): https://myaccount.google.com/apppasswords'
    echo 'Smtp__Host=smtp.gmail.com'
    echo 'Smtp__Port=587'
    echo 'Smtp__Username=your@gmail.com'
    echo 'Smtp__Password=GMAIL_APP_PASSWORD'
    echo 'Smtp__FromEmail=your@gmail.com'
    echo 'Smtp__FromName=Flora'
    echo 'Smtp__EnableSsl=true'
    echo '# FCM push (release mobile + message notifications):'
    echo 'Push__Firebase__CredentialsPath=/etc/flora-ecosystem/firebase-service-account.json'
    echo '# App-update broadcast (Scripts/broadcast-app-update.ps1 -Production):'
    echo 'Flora__AdminBroadcastToken=CHANGE_ME_LONG_RANDOM_SECRET'
  } >/etc/flora-ecosystem/flora-api.env.example
fi

rm -f /etc/nginx/conf.d/flora-x-forwarded-proto-map.conf || true

if [ ! -f /etc/systemd/system/flora-web.service ]; then
  mkdir -p /etc/systemd/system
  {
    echo '[Unit]'
    echo 'Description=Flora Web (Next standalone)'
    echo 'After=network.target'
    echo
    echo '[Service]'
    echo 'Type=simple'
    echo 'WorkingDirectory=/opt/flora-ecosystem/runtime/web'
    echo 'ExecStart=/usr/bin/node server.js'
    echo 'Restart=always'
    echo 'RestartSec=3'
    echo 'Environment=NODE_ENV=production'
    echo 'Environment=PORT=3000'
    echo
    echo '[Install]'
    echo 'WantedBy=multi-user.target'
  } >/etc/systemd/system/flora-web.service
fi

mkdir -p /etc/systemd/system/flora-web.service.d
{
  printf '%s\n' '[Service]'
  printf 'Environment=FLORA_API_UPSTREAM=%s\n' "$API_UPSTREAM"
  printf 'Environment=FLORA_AUTH_PROXY_CORS_ORIGINS=https://%s.%s,https://origin.%s\n' "$PUBLIC_SUBDOMAIN" "$DOMAIN" "$DOMAIN"
} >/etc/systemd/system/flora-web.service.d/50-flora-api-upstream.conf

systemctl daemon-reload
systemctl enable flora-web >/dev/null 2>&1 || true

mkdir -p /etc/systemd/system
{
  echo '[Unit]'
  echo 'Description=Flora.API (ASP.NET Core)'
  echo 'After=network.target'
  echo
  echo '[Service]'
  echo 'Type=simple'
  echo 'WorkingDirectory=/opt/flora-ecosystem/runtime/api'
  echo 'Environment=ASPNETCORE_ENVIRONMENT=Production'
  echo 'Environment=ASPNETCORE_URLS=http://127.0.0.1:5000'
  echo 'EnvironmentFile=-/etc/flora-ecosystem/flora-api-cors.env'
  echo 'EnvironmentFile=-/etc/flora-ecosystem/flora-api.env'
  echo 'ExecStart=/opt/flora-ecosystem/runtime/api/Flora.API'
  echo 'Restart=always'
  echo 'RestartSec=5'
  echo
  echo '[Install]'
  echo 'WantedBy=multi-user.target'
} >/etc/systemd/system/flora-api.service

{
  printf 'FloraWeb__CorsOrigins__0=https://%s.%s\n' "$PUBLIC_SUBDOMAIN" "$DOMAIN"
  printf 'FloraWeb__CorsOrigins__1=https://origin.%s\n' "$DOMAIN"
  echo 'FloraWeb__CorsOrigins__2=http://localhost:3000'
} >/etc/flora-ecosystem/flora-api-cors.env
chmod 644 /etc/flora-ecosystem/flora-api-cors.env

systemctl daemon-reload

mkdir -p /var/www/certbot

emit_nginx_proxy_next_static() {
  echo '    location /_next/static/ {'
  echo '        proxy_pass http://127.0.0.1:3000;'
  echo '        proxy_http_version 1.1;'
  echo '        proxy_set_header Host $host;'
  echo '        proxy_set_header X-Real-IP $remote_addr;'
  echo '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  echo '        proxy_set_header X-Forwarded-Proto $scheme;'
  echo '    }'
}

emit_nginx_api_admin() {
  echo '    location /api/admin/ {'
  echo '        proxy_pass http://127.0.0.1:5000;'
  echo '        proxy_http_version 1.1;'
  echo '        proxy_set_header Host $host;'
  echo '        proxy_set_header X-Real-IP $remote_addr;'
  echo '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  echo '        proxy_set_header X-Forwarded-Proto $scheme;'
  echo '        client_max_body_size 1m;'
  echo '    }'
  echo ''
}

emit_nginx_api_sse_stream() {
  echo '    location = /api/auth/signals/stream {'
  echo '        proxy_pass http://127.0.0.1:5000;'
  echo '        proxy_http_version 1.1;'
  echo '        proxy_set_header Host $host;'
  echo '        proxy_set_header X-Real-IP $remote_addr;'
  echo '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  echo '        proxy_set_header X-Forwarded-Proto $scheme;'
  echo '        proxy_set_header Authorization $http_authorization;'
  echo '        proxy_buffering off;'
  echo '        proxy_cache off;'
  echo '        proxy_read_timeout 86400s;'
  echo '    }'
}

emit_nginx_api_post_media() {
  echo '    # Public post media GET (anonymous <img>/<video>); bypass Next for binary + Range.'
  echo '    location ~ ^/api/auth/posts/(images|videos)/ {'
  echo '        proxy_pass http://127.0.0.1:5000;'
  echo '        proxy_http_version 1.1;'
  echo '        proxy_set_header Host $host;'
  echo '        proxy_set_header X-Real-IP $remote_addr;'
  echo '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  echo '        proxy_set_header X-Forwarded-Proto $scheme;'
  echo '        proxy_buffering off;'
  echo '    }'
  echo ''
}

emit_nginx_proxy_next_app() {
  if [[ -n "$WEB_BUILD_ID" ]]; then
    echo '    # CDN keys by full URL; ?b=buildId fetches fresh HTML without panel purge.'
    echo '    location = / {'
    echo "        return 302 \$scheme://\$host/login?b=${WEB_BUILD_ID};"
    echo '    }'
    echo '    location = /login {'
    echo "        if (\$arg_b != \"${WEB_BUILD_ID}\") {"
    echo "            return 302 \$scheme://\$host/login?b=${WEB_BUILD_ID};"
    echo '        }'
    echo '        proxy_pass http://127.0.0.1:3000;'
    echo '        proxy_http_version 1.1;'
    echo '        proxy_set_header Host $host;'
    echo '        proxy_set_header X-Real-IP $remote_addr;'
    echo '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
    echo '        proxy_set_header X-Forwarded-Proto $scheme;'
    echo '        proxy_hide_header Cache-Control;'
    echo '        add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;'
    echo '        add_header Pragma "no-cache" always;'
    echo '    }'
  fi
  echo '    location / {'
  echo '        proxy_pass http://127.0.0.1:3000;'
  echo '        proxy_http_version 1.1;'
  echo '        proxy_set_header Host $host;'
  echo '        proxy_set_header X-Real-IP $remote_addr;'
  echo '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  echo '        proxy_set_header X-Forwarded-Proto $scheme;'
  echo '        proxy_hide_header Cache-Control;'
  echo '        add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;'
  echo '        add_header Pragma "no-cache" always;'
  echo '    }'
}

write_flora_ip_allow_snippet() {
  if [[ -z "$ALLOWED_CLIENT_IPS" ]]; then
    rm -f /etc/nginx/snippets/flora-ip-allow.conf || true
    return
  fi
  mkdir -p /etc/nginx/snippets
  {
    echo '# Generated by remote-bootstrap-flora-web.sh — staging lock on apex/www redirect only.'
    echo '# CDN origin (social.* / origin.*) is always public; edge IPs are not allow-listed here.'
    local ip part
    local old_ifs="$IFS"
    IFS=','
    for part in $ALLOWED_CLIENT_IPS; do
      ip="${part//[[:space:]]/}"
      if [[ -n "$ip" ]]; then
        echo "allow ${ip};"
      fi
    done
    IFS="$old_ifs"
    echo 'allow 127.0.0.1;'
    echo 'deny all;'
  } >/etc/nginx/snippets/flora-ip-allow.conf
}

# IP lock applies only to apex/www redirect vhosts — never to CDN origin (social.* / origin.*).
emit_nginx_ip_allow_lines() {
  if [[ -n "$ALLOWED_CLIENT_IPS" ]]; then
    echo '        include /etc/nginx/snippets/flora-ip-allow.conf;'
  fi
}

write_flora_ip_allow_snippet

if [[ -n "$WEB_BUILD_ID" ]]; then
  mkdir -p /etc/flora-ecosystem
  echo "$WEB_BUILD_ID" >/etc/flora-ecosystem/web-build-id
  chmod 644 /etc/flora-ecosystem/web-build-id
fi

# apex + www → social (Selectel CDN). A @ → VPS (CNAME on @ is not allowed at most DNS panels).
{
  echo 'server {'
  echo '    listen 80;'
  echo "    server_name ${DOMAIN} www.${DOMAIN};"
  echo
  echo '    location /.well-known/acme-challenge/ {'
  echo '        root /var/www/certbot;'
  echo '    }'
  echo
  echo '    location / {'
  emit_nginx_ip_allow_lines
  if [[ -n "$WEB_BUILD_ID" ]]; then
    echo "        return 301 https://${PUBLIC_SUBDOMAIN}.${DOMAIN}/login?b=${WEB_BUILD_ID};"
  else
    echo "        return 301 https://${PUBLIC_SUBDOMAIN}.${DOMAIN}\$request_uri;"
  fi
  echo '    }'
  echo '}'
} >/etc/nginx/sites-available/flora-apex-redirect.conf

# Site (CDN origin :443 + HTTP :80). CDN connects to origin.<DOMAIN>:443, Host: social.<DOMAIN>.
{
  echo 'server {'
  echo '    listen 80;'
  echo "    server_name ${PUBLIC_SUBDOMAIN}.${DOMAIN} origin.${DOMAIN};"
  echo
  echo '    location /.well-known/acme-challenge/ {'
  echo '        root /var/www/certbot;'
  echo '    }'
  echo
  emit_nginx_proxy_next_static
  echo
  emit_nginx_api_admin
  emit_nginx_api_sse_stream
  emit_nginx_api_post_media
  echo
  emit_nginx_proxy_next_app
  echo '}'
} >/etc/nginx/sites-available/flora-web.conf

# Panel/hosting snippets often ship a self-signed TLS vhost (ERR_CERT_AUTHORITY_INVALID on apex).
rm -f /etc/nginx/conf.d/flora-web.conf /etc/nginx/conf.d/default.conf || true
rm -f /etc/nginx/sites-enabled/flora-web /etc/nginx/sites-enabled/00-flora-web || true
rm -f /etc/nginx/sites-enabled/00-flora-apex-site.conf /etc/nginx/sites-enabled/02-flora-apex-https-redirect.conf || true
ln -sf /etc/nginx/sites-available/flora-apex-redirect.conf /etc/nginx/sites-enabled/00-flora-apex-redirect.conf
ln -sf /etc/nginx/sites-available/flora-web.conf /etc/nginx/sites-enabled/00-flora-web.conf
rm -f /etc/nginx/sites-enabled/default || true
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

if [[ -n "$CERTBOT_EMAIL" ]] && [[ "$CERTBOT_EMAIL" == *"@"* ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y certbot || true
  certbot certonly --webroot -w /var/www/certbot \
    -d "origin.${DOMAIN}" \
    --non-interactive --agree-tos -m "$CERTBOT_EMAIL" \
    --keep-until-expiring || true
  # www.<DOMAIN> is optional in DNS; apex cert is enough for HTTPS redirect to ${PUBLIC_SUBDOMAIN}.${DOMAIN}.
  certbot certonly --webroot -w /var/www/certbot \
    -d "${DOMAIN}" \
    --non-interactive --agree-tos -m "$CERTBOT_EMAIL" \
    --keep-until-expiring || true
fi

ORIGIN_CERT="/etc/letsencrypt/live/origin.${DOMAIN}/fullchain.pem"
ORIGIN_KEY="/etc/letsencrypt/live/origin.${DOMAIN}/privkey.pem"
if [[ -f "$ORIGIN_CERT" && -f "$ORIGIN_KEY" ]]; then
  {
    echo 'server {'
    echo '    listen 443 ssl;'
    echo "    server_name origin.${DOMAIN} ${PUBLIC_SUBDOMAIN}.${DOMAIN};"
    echo "    ssl_certificate ${ORIGIN_CERT};"
    echo "    ssl_certificate_key ${ORIGIN_KEY};"
    echo
    emit_nginx_proxy_next_static
    echo
    emit_nginx_api_admin
    emit_nginx_api_sse_stream
    emit_nginx_api_post_media
    echo
    emit_nginx_proxy_next_app
    echo '}'
  } >/etc/nginx/sites-available/flora-origin-https.conf
  ln -sf /etc/nginx/sites-available/flora-origin-https.conf /etc/nginx/sites-enabled/01-flora-origin-https.conf
fi

APEX_CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
APEX_KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
if [[ -f "$APEX_CERT" && -f "$APEX_KEY" ]]; then
  {
    echo 'server {'
    echo '    listen 443 ssl;'
    echo "    server_name ${DOMAIN} www.${DOMAIN};"
    echo "    ssl_certificate ${APEX_CERT};"
    echo "    ssl_certificate_key ${APEX_KEY};"
    echo
    echo '    location / {'
    emit_nginx_ip_allow_lines
    if [[ -n "$WEB_BUILD_ID" ]]; then
      echo "        return 301 https://${PUBLIC_SUBDOMAIN}.${DOMAIN}/login?b=${WEB_BUILD_ID};"
    else
      echo "        return 301 https://${PUBLIC_SUBDOMAIN}.${DOMAIN}\$request_uri;"
    fi
    echo '    }'
    echo '}'
  } >/etc/nginx/sites-available/flora-apex-https-redirect.conf
  ln -sf /etc/nginx/sites-available/flora-apex-https-redirect.conf /etc/nginx/sites-enabled/02-flora-apex-https-redirect.conf
  rm -f /etc/nginx/sites-enabled/02-flora-apex-https.conf || true
fi

nginx -t
systemctl reload nginx || systemctl restart nginx
