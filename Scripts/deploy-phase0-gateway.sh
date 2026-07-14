#!/bin/bash
# Phase 0 cutover on VPS: install Rust flora-api gateway, keep .NET as flora-api-dotnet.
# Run as root on the server after flora-api binary is built to
# /opt/flora-ecosystem/runtime/gateway/flora-api
set -euo pipefail

GATEWAY_DIR=/opt/flora-ecosystem/runtime/gateway
DOTNET_DIR=/opt/flora-ecosystem/runtime/api
ENV_FILE=/etc/flora-ecosystem/flora-api.env
CORS_ENV=/etc/flora-ecosystem/flora-api-cors.env
GATEWAY_ENV=/etc/flora-ecosystem/flora-gateway.env

if [[ ! -x "$GATEWAY_DIR/flora-api" ]]; then
  echo "missing binary: $GATEWAY_DIR/flora-api" >&2
  exit 1
fi

# --- .NET unit rename (keep port 5000) ---
if [[ -f /etc/systemd/system/flora-api.service ]] && ! grep -q 'Flora.API (ASP.NET' /etc/systemd/system/flora-api-dotnet.service 2>/dev/null; then
  if systemctl cat flora-api.service 2>/dev/null | grep -q 'Flora.API (ASP.NET'; then
    cp -a /etc/systemd/system/flora-api.service /etc/systemd/system/flora-api-dotnet.service
    # rewrite description only if still the old unit name file
    sed -i 's/^Description=.*/Description=Flora.API .NET upstream (Phase 0+)/' /etc/systemd/system/flora-api-dotnet.service
  fi
fi

if [[ ! -f /etc/systemd/system/flora-api-dotnet.service ]]; then
  cat >/etc/systemd/system/flora-api-dotnet.service <<'EOF'
[Unit]
Description=Flora.API .NET upstream (Phase 0+)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/flora-ecosystem/runtime/api
Environment=ASPNETCORE_ENVIRONMENT=Production
Environment=ASPNETCORE_URLS=http://127.0.0.1:5000
EnvironmentFile=-/etc/flora-ecosystem/flora-api-cors.env
EnvironmentFile=-/etc/flora-ecosystem/flora-api.env
ExecStart=/opt/flora-ecosystem/runtime/api/Flora.API
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
fi

# Gateway env: same secrets as .NET + listen/upstream overrides
{
  echo 'FLORA_ENVIRONMENT=Production'
  echo 'ASPNETCORE_ENVIRONMENT=Production'
  echo 'Gateway__Listen=127.0.0.1:5290'
  echo 'Gateway__DotnetUpstream=http://127.0.0.1:5000'
  echo 'RUST_LOG=info'
  # Reuse Jwt/Cors from existing env files via EnvironmentFile stacking
} >"$GATEWAY_ENV"
chmod 600 "$GATEWAY_ENV"

if [[ -f "$GATEWAY_DIR/appsettings.json" ]]; then
  :
else
  cat >"$GATEWAY_DIR/appsettings.json" <<'EOF'
{
  "Gateway": {
    "Listen": "127.0.0.1:5290",
    "DotnetUpstream": "http://127.0.0.1:5000"
  }
}
EOF
fi

if [[ -f "$GATEWAY_DIR/VERSION" && ! -f "$GATEWAY_DIR/flora-versions.json" ]]; then
  cp -a "$GATEWAY_DIR/VERSION" "$GATEWAY_DIR/flora-versions.json"
fi

cat >/etc/systemd/system/flora-api.service <<'EOF'
[Unit]
Description=Flora API gateway (Rust, Phase 0+)
After=network.target flora-api-dotnet.service
Wants=flora-api-dotnet.service

[Service]
Type=simple
WorkingDirectory=/opt/flora-ecosystem/runtime/gateway
Environment=FLORA_ENVIRONMENT=Production
Environment=ASPNETCORE_ENVIRONMENT=Production
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

# Start .NET under new unit name; stop old if still bound to ASP.NET binary under flora-api
if systemctl is-active --quiet flora-api; then
  # If current flora-api is still .NET, move traffic carefully:
  if systemctl cat flora-api | grep -q 'runtime/api/Flora.API'; then
    systemctl stop flora-api
  fi
fi

systemctl enable flora-api-dotnet >/dev/null 2>&1 || true
systemctl restart flora-api-dotnet
sleep 2
systemctl is-active flora-api-dotnet
curl -fsS http://127.0.0.1:5000/health >/dev/null

systemctl enable flora-api >/dev/null 2>&1 || true
systemctl restart flora-api
sleep 2
systemctl is-active flora-api
curl -fsS http://127.0.0.1:5290/health
echo
curl -fsS http://127.0.0.1:5290/version
echo
# Proxied route smoke (login shape may 400/401 — must not 502)
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5290/api/auth/login || true)
echo "proxy /api/auth/login -> HTTP $code"

echo "Gateway up on :5290. Next: flip nginx 5000 -> 5290 (patch-nginx-phase0-gateway.sh)"
