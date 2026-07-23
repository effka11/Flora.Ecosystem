#!/bin/bash
# Phase 5: install Rust flora-api on VPS (no .NET upstream).
# Expects payload dir with: flora-api, flora-migrate (ELF), flora-versions.json,
# optional appsettings.json.
# Usage: bash remote-install-flora-api.sh /tmp/flora-api-payload
set -euo pipefail

PAYLOAD="${1:?payload directory}"
GATEWAY_DIR=/opt/flora-ecosystem/runtime/gateway
ENV_DIR=/etc/flora-ecosystem
SERVICE_USER=flora-api

if [[ ! -f "$PAYLOAD/flora-api" ]]; then
  echo "missing $PAYLOAD/flora-api" >&2
  exit 1
fi
if [[ ! -f "$PAYLOAD/flora-migrate" ]]; then
  echo "missing $PAYLOAD/flora-migrate" >&2
  exit 1
fi

mkdir -p "$GATEWAY_DIR" "$ENV_DIR"
if ! getent group "$SERVICE_USER" >/dev/null; then
  groupadd --system "$SERVICE_USER"
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_USER" --home-dir "$GATEWAY_DIR" \
    --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -m 755 "$PAYLOAD/flora-api" "$GATEWAY_DIR/flora-api.new"
mv -f "$GATEWAY_DIR/flora-api.new" "$GATEWAY_DIR/flora-api"
chmod 755 "$GATEWAY_DIR/flora-api"
install -m 755 "$PAYLOAD/flora-migrate" "$GATEWAY_DIR/flora-migrate.new"
mv -f "$GATEWAY_DIR/flora-migrate.new" "$GATEWAY_DIR/flora-migrate"
chmod 755 "$GATEWAY_DIR/flora-migrate"

if [[ -f "$PAYLOAD/flora-versions.json" ]]; then
  install -m 644 "$PAYLOAD/flora-versions.json" "$GATEWAY_DIR/flora-versions.json"
fi

# Baseline Gateway listen only when missing — never overwrite prod appsettings with secrets.
if [[ ! -f "$GATEWAY_DIR/appsettings.json" ]]; then
  if [[ -f "$PAYLOAD/appsettings.json" ]]; then
    install -o root -g "$SERVICE_USER" -m 640 \
      "$PAYLOAD/appsettings.json" "$GATEWAY_DIR/appsettings.json"
  else
    cat >"$GATEWAY_DIR/appsettings.json" <<'EOF'
{
  "Gateway": {
    "Listen": "127.0.0.1:5290",
    "DotnetUpstream": "",
    "TrustedProxies": [ "127.0.0.0/8", "::1/128" ]
  }
}
EOF
  fi
fi
chown root:"$SERVICE_USER" "$GATEWAY_DIR/appsettings.json"
chmod 640 "$GATEWAY_DIR/appsettings.json"

# Phase 5 gateway env (no DotnetUpstream).
{
  echo 'FLORA_ENVIRONMENT=Production'
  echo 'Gateway__Listen=127.0.0.1:5290'
  echo 'Gateway__DotnetUpstream='
  echo 'Gateway__TrustedProxies__0=127.0.0.0/8'
  echo 'Gateway__TrustedProxies__1=::1/128'
  echo 'RUST_LOG=info'
} >"$ENV_DIR/flora-gateway.env"
chmod 600 "$ENV_DIR/flora-gateway.env"

if [[ ! -f "$ENV_DIR/flora-api.env" ]]; then
  echo "WARNING: missing $ENV_DIR/flora-api.env — create from flora-api.env.example before traffic." >&2
fi
if [[ -f "$ENV_DIR/firebase-service-account.json" ]]; then
  chown root:"$SERVICE_USER" "$ENV_DIR/firebase-service-account.json"
  chmod 640 "$ENV_DIR/firebase-service-account.json"
fi

cat >/etc/systemd/system/flora-api.service <<'EOF'
[Unit]
Description=Flora API
After=network.target
# Phase 5: sole HTTP host — do not Wants= flora-api-dotnet.

[Service]
Type=simple
User=flora-api
Group=flora-api
UMask=0077
WorkingDirectory=/opt/flora-ecosystem/runtime/gateway
Environment=FLORA_ENVIRONMENT=Production
Environment=FLORA_CONFIG_DIR=/opt/flora-ecosystem/runtime/gateway
Environment=FLORA_VERSIONS_PATH=/opt/flora-ecosystem/runtime/gateway/flora-versions.json
EnvironmentFile=-/etc/flora-ecosystem/flora-api-cors.env
EnvironmentFile=-/etc/flora-ecosystem/flora-api.env
EnvironmentFile=-/etc/flora-ecosystem/flora-gateway.env
ExecStart=/opt/flora-ecosystem/runtime/gateway/flora-api
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/flora-migrate.service <<'EOF'
[Unit]
Description=Flora module database migrations
After=network.target

[Service]
Type=oneshot
User=flora-api
Group=flora-api
UMask=0077
WorkingDirectory=/opt/flora-ecosystem/runtime/gateway
Environment=FLORA_ENVIRONMENT=Production
Environment=FLORA_CONFIG_DIR=/opt/flora-ecosystem/runtime/gateway
EnvironmentFile=-/etc/flora-ecosystem/flora-api.env
EnvironmentFile=-/etc/flora-ecosystem/flora-gateway.env
ExecStart=/opt/flora-ecosystem/runtime/gateway/flora-migrate
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
EOF

systemctl daemon-reload

# Schema must be ready before the new API process starts. A failed migration
# aborts deploy while the previous API process remains running.
echo "Applying Flora module migrations..."
systemctl reset-failed flora-migrate >/dev/null 2>&1 || true
systemctl start flora-migrate
echo "Flora module migrations applied."

# Retire Phase 0 .NET upstream if still present.
if systemctl list-unit-files flora-api-dotnet.service >/dev/null 2>&1; then
  systemctl disable --now flora-api-dotnet >/dev/null 2>&1 || true
fi

systemctl enable flora-api >/dev/null 2>&1 || true
systemctl restart flora-api
sleep 2
systemctl is-active flora-api
curl -fsS http://127.0.0.1:5290/health
echo
curl -fsS http://127.0.0.1:5290/version
echo
echo "Flora API up on :5290"
