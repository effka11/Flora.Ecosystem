#!/bin/bash
# Phase 5: install Rust flora-api on VPS (no .NET upstream).
# Expects payload dir with: flora-api (ELF), flora-versions.json, optional appsettings.json
# Usage: bash remote-install-flora-api.sh /tmp/flora-api-payload
set -euo pipefail

PAYLOAD="${1:?payload directory}"
GATEWAY_DIR=/opt/flora-ecosystem/runtime/gateway
ENV_DIR=/etc/flora-ecosystem

if [[ ! -f "$PAYLOAD/flora-api" ]]; then
  echo "missing $PAYLOAD/flora-api" >&2
  exit 1
fi

mkdir -p "$GATEWAY_DIR" "$ENV_DIR"

install -m 755 "$PAYLOAD/flora-api" "$GATEWAY_DIR/flora-api.new"
mv -f "$GATEWAY_DIR/flora-api.new" "$GATEWAY_DIR/flora-api"
chmod 755 "$GATEWAY_DIR/flora-api"

if [[ -f "$PAYLOAD/flora-versions.json" ]]; then
  install -m 644 "$PAYLOAD/flora-versions.json" "$GATEWAY_DIR/flora-versions.json"
fi

# Baseline Gateway listen only when missing — never overwrite prod appsettings with secrets.
if [[ ! -f "$GATEWAY_DIR/appsettings.json" ]]; then
  if [[ -f "$PAYLOAD/appsettings.json" ]]; then
    install -m 644 "$PAYLOAD/appsettings.json" "$GATEWAY_DIR/appsettings.json"
  else
    cat >"$GATEWAY_DIR/appsettings.json" <<'EOF'
{
  "Gateway": {
    "Listen": "127.0.0.1:5290",
    "DotnetUpstream": ""
  }
}
EOF
    chmod 644 "$GATEWAY_DIR/appsettings.json"
  fi
fi

# Phase 5 gateway env (no DotnetUpstream).
{
  echo 'FLORA_ENVIRONMENT=Production'
  echo 'Gateway__Listen=127.0.0.1:5290'
  echo 'Gateway__DotnetUpstream='
  echo 'RUST_LOG=info'
} >"$ENV_DIR/flora-gateway.env"
chmod 600 "$ENV_DIR/flora-gateway.env"

if [[ ! -f "$ENV_DIR/flora-api.env" ]]; then
  echo "WARNING: missing $ENV_DIR/flora-api.env — create from flora-api.env.example before traffic." >&2
fi

cat >/etc/systemd/system/flora-api.service <<'EOF'
[Unit]
Description=Flora API
After=network.target
# Phase 5: sole HTTP host — do not Wants= flora-api-dotnet.

[Service]
Type=simple
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

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

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
