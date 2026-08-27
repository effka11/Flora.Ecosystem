#!/bin/bash
# Usage: bash remote-bootstrap-flora-gov.sh args.txt
# Arg file: line 1 REMOTE_PATH, 2 DOMAIN, 3 API_UPSTREAM.
# systemd flora-gov on 127.0.0.1:3001. Does not rewrite nginx (gov vhost comes
# from Apps/Web remote-bootstrap-flora-web.sh).
set -euo pipefail

ARGS_FILE="${1:?path to args file}"

REMOTE_PATH="$(sed -n '1p' "$ARGS_FILE" | tr -d '\r')"
DOMAIN="$(sed -n '2p' "$ARGS_FILE" | tr -d '\r')"
API_UPSTREAM="$(sed -n '3p' "$ARGS_FILE" | tr -d '\r' || true)"
API_UPSTREAM="${API_UPSTREAM//[[:space:]]/}"

if [[ -z "$REMOTE_PATH" || -z "$DOMAIN" ]]; then
  echo "ARGS file must define REMOTE_PATH and DOMAIN on lines 1 and 2." >&2
  exit 1
fi

[[ -z "$API_UPSTREAM" ]] && API_UPSTREAM='http://127.0.0.1:5290'
GOV_SERVICE_USER='flora-gov'

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing. Install Node 20+ (social web bootstrap does this) before deploying Gov." >&2
  exit 1
fi

if [[ ! -f /etc/nginx/sites-available/flora-gov.conf ]]; then
  echo "nginx gov vhost missing (/etc/nginx/sites-available/flora-gov.conf)." >&2
  echo "Run Apps/Web remote-bootstrap first so gov.${DOMAIN} proxies to :3001." >&2
  exit 1
fi

mkdir -p "$REMOTE_PATH"
if ! getent group "$GOV_SERVICE_USER" >/dev/null; then
  groupadd --system "$GOV_SERVICE_USER"
fi
if ! id -u "$GOV_SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$GOV_SERVICE_USER" --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$GOV_SERVICE_USER"
fi

chown -R root:"$GOV_SERVICE_USER" "$REMOTE_PATH"
find "$REMOTE_PATH" -type d -exec chmod 750 {} +
find "$REMOTE_PATH" -type f -exec chmod 640 {} +
mkdir -p "$REMOTE_PATH/.next/cache"
chown -R "$GOV_SERVICE_USER:$GOV_SERVICE_USER" "$REMOTE_PATH/.next/cache"
chmod 750 "$REMOTE_PATH/.next/cache"

if [ ! -f /etc/systemd/system/flora-gov.service ]; then
  mkdir -p /etc/systemd/system
  {
    echo '[Unit]'
    echo 'Description=Flora Gov (Next standalone)'
    echo 'After=network.target'
    echo
    echo '[Service]'
    echo 'Type=simple'
    echo 'WorkingDirectory=/opt/flora-ecosystem/runtime/gov'
    echo 'ExecStart=/usr/bin/node server.js'
    echo 'Restart=always'
    echo 'RestartSec=3'
    echo 'Environment=NODE_ENV=production'
    echo 'Environment=PORT=3001'
    echo
    echo '[Install]'
    echo 'WantedBy=multi-user.target'
  } >/etc/systemd/system/flora-gov.service
fi

mkdir -p /etc/systemd/system/flora-gov.service.d
{
  printf '%s\n' \
    '[Service]' \
    "User=${GOV_SERVICE_USER}" \
    "Group=${GOV_SERVICE_USER}" \
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
    'AmbientCapabilities='
} >/etc/systemd/system/flora-gov.service.d/40-security.conf
{
  printf '%s\n' '[Service]'
  printf 'Environment=FLORA_API_UPSTREAM=%s\n' "$API_UPSTREAM"
} >/etc/systemd/system/flora-gov.service.d/50-flora-api-upstream.conf

systemctl daemon-reload
systemctl enable flora-gov >/dev/null 2>&1 || true
