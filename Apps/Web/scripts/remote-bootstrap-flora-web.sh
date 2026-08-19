#!/bin/bash
# Usage: bash /tmp/remote-bootstrap-flora-web.sh /tmp/flora-args.txt
# Arg file: line 1 REMOTE_PATH, 2 DOMAIN, 3 API_UPSTREAM, 4 CERTBOT_EMAIL (optional),
# 5 ALLOWED_CLIENT_IPS (optional, unused: public origins are not IP-locked),
# 6 PUBLIC_SUBDOMAIN (optional, default social — CDN site host),
# 7 WEB_BUILD_ID (optional — CDN cache-bust ?b= without panel purge).
# Origins: apex Www shell, gov.* → :3001, social.* + origin.* → :3000 / flora-api.
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

# Phase 5: Next → Rust flora-api :5290 (sole HTTP host).
[[ -z "$API_UPSTREAM" ]] && API_UPSTREAM='http://127.0.0.1:5290'
WEB_SERVICE_USER='flora-web'

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
if ! getent group "$WEB_SERVICE_USER" >/dev/null; then
  groupadd --system "$WEB_SERVICE_USER"
fi
if ! id -u "$WEB_SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$WEB_SERVICE_USER" --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$WEB_SERVICE_USER"
fi
# Runtime code stays root-owned so a compromised Next process cannot persist
# by replacing server.js or dependencies. Only the documented Next cache is writable.
chown -R root:"$WEB_SERVICE_USER" "$REMOTE_PATH"
find "$REMOTE_PATH" -type d -exec chmod 750 {} +
find "$REMOTE_PATH" -type f -exec chmod 640 {} +
mkdir -p "$REMOTE_PATH/.next/cache"
chown -R "$WEB_SERVICE_USER:$WEB_SERVICE_USER" "$REMOTE_PATH/.next/cache"
chmod 750 "$REMOTE_PATH/.next/cache"

mkdir -p /etc/flora-ecosystem
if [ ! -f /etc/flora-ecosystem/flora-api.env.example ]; then
  {
    echo '# sudo cp /etc/flora-ecosystem/flora-api.env.example /etc/flora-ecosystem/flora-api.env && sudo chmod 600 /etc/flora-ecosystem/flora-api.env'
    echo 'ConnectionStrings__FloraDatabase=Host=127.0.0.1;Port=5432;Database=flora_social;Username=flora;Password=CHANGE_ME;Include Error Detail=false;Search Path=flora_core;SSL Mode=Require'
    echo 'Jwt__Secret=CHANGE_ME_TO_AT_LEAST_32_RANDOM_CHARACTERS'
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
    echo 'Description=Flora (Next standalone)'
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
  printf '%s\n' \
    '[Service]' \
    "User=${WEB_SERVICE_USER}" \
    "Group=${WEB_SERVICE_USER}" \
    'Environment=HOSTNAME=127.0.0.1' \
    'UMask=0027' \
    'NoNewPrivileges=true' \
    'PrivateTmp=true' \
    'ProtectSystem=strict' \
    'ProtectHome=true' \
    'ProtectKernelTunables=true' \
    'ProtectKernelModules=true' \
    'ProtectControlGroups=true' \
    'RestrictSUIDSGID=true' \
    'LockPersonality=true' \
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
    'CapabilityBoundingSet=' \
    'AmbientCapabilities=' \
    "ReadWritePaths=${REMOTE_PATH}/.next/cache"
} >/etc/systemd/system/flora-web.service.d/40-security.conf
{
  printf '%s\n' '[Service]'
  printf 'Environment=FLORA_API_UPSTREAM=%s\n' "$API_UPSTREAM"
  printf 'Environment=FLORA_AUTH_PROXY_CORS_ORIGINS=https://%s.%s,https://origin.%s\n' "$PUBLIC_SUBDOMAIN" "$DOMAIN" "$DOMAIN"
} >/etc/systemd/system/flora-web.service.d/50-flora-api-upstream.conf

systemctl daemon-reload
systemctl enable flora-web >/dev/null 2>&1 || true

# Phase 5: .NET Flora.API removed — do not install flora-api-dotnet.
# Rust flora-api is managed separately under /opt/flora-ecosystem/runtime/gateway/.
if systemctl list-unit-files flora-api-dotnet.service >/dev/null 2>&1; then
  systemctl disable --now flora-api-dotnet >/dev/null 2>&1 || true
fi

{
  printf 'FloraWeb__CorsOrigins__0=https://%s.%s\n' "$PUBLIC_SUBDOMAIN" "$DOMAIN"
  printf 'FloraWeb__CorsOrigins__1=https://origin.%s\n' "$DOMAIN"
  printf 'FloraWeb__CorsOrigins__2=https://gov.%s\n' "$DOMAIN"
} >/etc/flora-ecosystem/flora-api-cors.env
chmod 644 /etc/flora-ecosystem/flora-api-cors.env

systemctl daemon-reload

mkdir -p /var/www/certbot
mkdir -p /var/www/flora-apk

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
  echo '        proxy_pass http://127.0.0.1:5290;'
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
  echo '        proxy_pass http://127.0.0.1:5290;'
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
  echo '        proxy_pass http://127.0.0.1:5290;'
  echo '        proxy_http_version 1.1;'
  echo '        proxy_set_header Host $host;'
  echo '        proxy_set_header X-Real-IP $remote_addr;'
  echo '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  echo '        proxy_set_header X-Forwarded-Proto $scheme;'
  echo '        proxy_buffering off;'
  echo '    }'
  echo ''
}

# Sideload APK channel (independent of GitHub). Must be before catch-all location /.
emit_nginx_apk_channel() {
  echo '    # Flora Social Android APK channel (static; bypass Next).'
  echo '    location = /apk/releases.json {'
  echo '        alias /var/www/flora-apk/releases.json;'
  echo '        default_type application/json;'
  echo '        add_header Cache-Control "no-store" always;'
  echo '    }'
  echo '    location = /apk/flora.social-android-update.json {'
  echo '        alias /var/www/flora-apk/flora.social-android-update.json;'
  echo '        default_type application/json;'
  echo '        add_header Cache-Control "no-store" always;'
  echo '    }'
  echo '    location /apk/ {'
  echo '        alias /var/www/flora-apk/;'
  echo '        types { application/vnd.android.package-archive apk; }'
  echo '        default_type application/octet-stream;'
  echo '        add_header Cache-Control "public, max-age=31536000, immutable" always;'
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

install_flora_www_root() {
  local payload_dir www_src www_root social_origin gov_origin
  payload_dir="$(cd "$(dirname "$ARGS_FILE")" && pwd)"
  www_src="${payload_dir}/www"
  www_root=/var/www/flora-www
  social_origin="https://${PUBLIC_SUBDOMAIN}.${DOMAIN}"
  gov_origin="https://gov.${DOMAIN}"
  mkdir -p "$www_root"
  if [[ -d "$www_src" ]]; then
    cp -a "${www_src}/." "$www_root/"
  fi
  if [[ ! -f "$www_root/health.json" ]]; then
    printf '{"status":"healthy","service":"%s"}\n' "$DOMAIN" >"$www_root/health.json"
  fi
  if [[ ! -f "$www_root/index.html" ]]; then
    printf '%s\n' "<!doctype html><title>Flora</title><p>Flora</p>" >"$www_root/index.html"
  fi
  local f
  for f in "$www_root/index.html" "$www_root/health.json"; do
    sed -i \
      -e "s|__DOMAIN__|${DOMAIN}|g" \
      -e "s|__SOCIAL_ORIGIN__|${social_origin}|g" \
      -e "s|__GOV_ORIGIN__|${gov_origin}|g" \
      "$f"
  done
  find "$www_root" -type d -exec chmod 755 {} +
  find "$www_root" -type f -exec chmod 644 {} +
}

emit_nginx_apex_shell() {
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
}

emit_nginx_gov_proxy() {
  echo '    location / {'
  echo '        proxy_pass http://127.0.0.1:3001;'
  echo '        proxy_http_version 1.1;'
  echo '        proxy_set_header Host $host;'
  echo '        proxy_set_header X-Real-IP $remote_addr;'
  echo '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  echo '        proxy_set_header X-Forwarded-Proto $scheme;'
  echo '        proxy_read_timeout 86400s;'
  echo '    }'
}

write_flora_ip_allow_snippet() {
  if [[ -z "$ALLOWED_CLIENT_IPS" ]]; then
    rm -f /etc/nginx/snippets/flora-ip-allow.conf || true
    return
  fi
  mkdir -p /etc/nginx/snippets
  {
    echo '# Generated by remote-bootstrap-flora-web.sh — unused on public origins (apex/gov/social).'
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

# Staging IP lock is not applied: apex is the public Www shell, gov/social/origin stay public.
emit_nginx_ip_allow_lines() {
  :
}

write_flora_ip_allow_snippet
install_flora_www_root

if [[ -n "$WEB_BUILD_ID" ]]; then
  mkdir -p /etc/flora-ecosystem
  echo "$WEB_BUILD_ID" >/etc/flora-ecosystem/web-build-id
  chmod 644 /etc/flora-ecosystem/web-build-id
fi

# Apex Www shell (Apps/Www). www.* → https://apex. A @ → VPS.
{
  echo 'server {'
  echo '    listen 80;'
  echo "    server_name ${DOMAIN};"
  echo
  echo '    location /.well-known/acme-challenge/ {'
  echo '        root /var/www/certbot;'
  echo '    }'
  echo
  echo "    location / { return 301 https://${DOMAIN}\$request_uri; }"
  echo '}'
  echo
  echo 'server {'
  echo '    listen 80;'
  echo "    server_name www.${DOMAIN};"
  echo "    return 301 https://${DOMAIN}\$request_uri;"
  echo '}'
} >/etc/nginx/sites-available/flora-apex.conf

{
  echo 'server {'
  echo '    listen 80;'
  echo "    server_name gov.${DOMAIN};"
  echo
  echo '    location /.well-known/acme-challenge/ {'
  echo '        root /var/www/certbot;'
  echo '    }'
  echo
  emit_nginx_gov_proxy
  echo '}'
} >/etc/nginx/sites-available/flora-gov.conf

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
  emit_nginx_apk_channel
  emit_nginx_proxy_next_app
  echo '}'
} >/etc/nginx/sites-available/flora-web.conf

# Panel/hosting snippets often ship a self-signed TLS vhost (ERR_CERT_AUTHORITY_INVALID on apex).
rm -f /etc/nginx/conf.d/flora-web.conf /etc/nginx/conf.d/default.conf || true
rm -f /etc/nginx/sites-enabled/flora-web /etc/nginx/sites-enabled/00-flora-web || true
rm -f /etc/nginx/sites-enabled/00-flora-apex-site.conf /etc/nginx/sites-enabled/00-flora-apex-redirect.conf || true
rm -f /etc/nginx/sites-enabled/02-flora-apex-https-redirect.conf /etc/nginx/sites-enabled/02-flora-apex-https.conf || true
ln -sf /etc/nginx/sites-available/flora-apex.conf /etc/nginx/sites-enabled/00-flora-apex.conf
ln -sf /etc/nginx/sites-available/flora-gov.conf /etc/nginx/sites-enabled/00-flora-gov.conf
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
  certbot certonly --webroot -w /var/www/certbot \
    -d "${DOMAIN}" \
    --non-interactive --agree-tos -m "$CERTBOT_EMAIL" \
    --keep-until-expiring || true
  certbot certonly --webroot -w /var/www/certbot \
    -d "gov.${DOMAIN}" \
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
    emit_nginx_apk_channel
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
    echo "    server_name ${DOMAIN};"
    echo "    ssl_certificate ${APEX_CERT};"
    echo "    ssl_certificate_key ${APEX_KEY};"
    echo
    emit_nginx_apex_shell
    echo '}'
  } >/etc/nginx/sites-available/flora-apex-https.conf
  ln -sf /etc/nginx/sites-available/flora-apex-https.conf /etc/nginx/sites-enabled/02-flora-apex-https.conf
  rm -f /etc/nginx/sites-enabled/02-flora-apex-https-redirect.conf || true
fi

GOV_CERT="/etc/letsencrypt/live/gov.${DOMAIN}/fullchain.pem"
GOV_KEY="/etc/letsencrypt/live/gov.${DOMAIN}/privkey.pem"
if [[ -f "$GOV_CERT" && -f "$GOV_KEY" ]]; then
  {
    echo 'server {'
    echo '    listen 443 ssl;'
    echo "    server_name gov.${DOMAIN};"
    echo "    ssl_certificate ${GOV_CERT};"
    echo "    ssl_certificate_key ${GOV_KEY};"
    echo
    emit_nginx_gov_proxy
    echo '}'
  } >/etc/nginx/sites-available/flora-gov-https.conf
  ln -sf /etc/nginx/sites-available/flora-gov-https.conf /etc/nginx/sites-enabled/02-flora-gov-https.conf
fi

nginx -t
systemctl reload nginx || systemctl restart nginx
