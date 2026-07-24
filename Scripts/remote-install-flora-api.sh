#!/usr/bin/env bash
# Phase 5: install Rust flora-api on VPS (no .NET upstream).
# Expects payload dir with: flora-api, flora-migrate (ELF), flora-versions.json,
# optional appsettings.json.
# Usage: bash remote-install-flora-api.sh /tmp/flora-api-payload
#
# Auth protocol rollback after retry-safe refresh is enabled is deliberately
# not a raw symlink flip. Follow Documents/ecosystem/AUTH-SESSION-ROLLOUT.md:
# drain rotations, keep replay reads available, wait G + request timeout, then
# restore the previous release. Additive schema and replay keys are retained.
set -Eeuo pipefail

PAYLOAD="${1:?payload directory}"
GATEWAY_DIR=/opt/flora-ecosystem/runtime/gateway
RELEASES_DIR="$GATEWAY_DIR/releases"
CURRENT_LINK="$GATEWAY_DIR/current"
PREVIOUS_LINK="$GATEWAY_DIR/previous"
STAGED_LINK="$GATEWAY_DIR/staged"
ENV_DIR=/etc/flora-ecosystem
SERVICE_USER=flora-api
REPLAY_CAPABILITY_MARKER=auth-retry-safe-capable
HEALTH_URL="${FLORA_API_HEALTH_URL:-http://127.0.0.1:5290/health}"
VERSION_URL="${FLORA_API_VERSION_URL:-http://127.0.0.1:5290/version}"
HEALTH_ATTEMPTS="${FLORA_API_HEALTH_ATTEMPTS:-12}"
HEALTH_RETRY_DELAY_SECONDS="${FLORA_API_HEALTH_RETRY_DELAY_SECONDS:-2}"
HEALTH_REQUEST_TIMEOUT_SECONDS="${FLORA_API_REQUEST_TIMEOUT_SECONDS:-5}"

if [[ $EUID -ne 0 ]]; then
  echo "remote installer must run as root" >&2
  exit 1
fi
if [[ ! -d "$PAYLOAD" ]]; then
  echo "missing payload directory $PAYLOAD" >&2
  exit 1
fi
PAYLOAD="$(cd -- "$PAYLOAD" && pwd -P)"
if [[ ! -f "$PAYLOAD/flora-api" ]]; then
  echo "missing $PAYLOAD/flora-api" >&2
  exit 1
fi
if [[ ! -f "$PAYLOAD/flora-migrate" ]]; then
  echo "missing $PAYLOAD/flora-migrate" >&2
  exit 1
fi
if [[ ! "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "FLORA_API_HEALTH_ATTEMPTS must be a positive integer" >&2
  exit 1
fi

release_hash="$(sha256sum "$PAYLOAD/flora-api" | awk '{print substr($1, 1, 12)}')"
RELEASE_ID="${FLORA_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$release_hash}"
if [[ ! "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid release id: $RELEASE_ID" >&2
  exit 1
fi
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
RELEASE_TMP="$RELEASES_DIR/.${RELEASE_ID}.staging.$$"

previous_target=
switched=0
completed=0

atomic_symlink() {
  local target="$1"
  local link="$2"
  local temporary="${link}.next.$$"
  rm -f -- "$temporary"
  ln -s -- "$target" "$temporary"
  mv -Tf -- "$temporary" "$link"
}

retry_safe_refresh_enabled() {
  local key
  local value
  [[ -f "$ENV_DIR/flora-api.env" ]] || return 1
  while IFS='=' read -r key value; do
    key="${key//[[:space:]]/}"
    if [[ "$key" == "Auth__RetrySafeRefresh" ]]; then
      value="${value%$'\r'}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      value="${value#\"}"
      value="${value%\"}"
      value="${value#\'}"
      value="${value%\'}"
      case "${value,,}" in
        true | 1) return 0 ;;
      esac
    fi
  done <"$ENV_DIR/flora-api.env"
  return 1
}

wait_for_health() {
  local label="$1"
  local attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if curl --silent --show-error --fail \
      --connect-timeout 2 \
      --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" \
      "$HEALTH_URL" >/dev/null; then
      echo "$label passed health check on attempt $attempt."
      return 0
    fi
    sleep "$HEALTH_RETRY_DELAY_SECONDS"
  done
  echo "$label failed health check after $HEALTH_ATTEMPTS attempts." >&2
  return 1
}

cleanup_staged_link() {
  if [[ -L "$STAGED_LINK" ]] \
    && [[ "$(readlink -f -- "$STAGED_LINK" 2>/dev/null || true)" == "$RELEASE_DIR" ]]; then
    rm -f -- "$STAGED_LINK"
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  set +e
  cleanup_staged_link
  if [[ -d "$RELEASE_TMP" ]]; then
    rm -rf -- "$RELEASE_TMP"
  fi

  if ((status != 0 && switched == 1 && completed == 0)); then
    if retry_safe_refresh_enabled \
      && [[ ! -f "$previous_target/$REPLAY_CAPABILITY_MARKER" ]]; then
      echo "Refusing automatic downgrade to a non-replay-safe release." >&2
      echo "Keep schema/keys; use a replay-safe forward fix or documented drain." >&2
      systemctl stop flora-api
    elif [[ -n "$previous_target" && -x "$previous_target/flora-api" ]]; then
      echo "Deployment failed after API switch; restoring $previous_target ..." >&2
      atomic_symlink "$previous_target" "$CURRENT_LINK"
      systemctl restart flora-api
      if wait_for_health "Restored Flora API"; then
        echo "Previous binary restored. Applied additive migrations were retained." >&2
      else
        echo "CRITICAL: previous binary was restored but is not healthy." >&2
      fi
    else
      echo "Deployment failed and no previous release exists; stopping Flora API." >&2
      systemctl stop flora-api
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

mkdir -p "$GATEWAY_DIR" "$RELEASES_DIR" "$ENV_DIR"
if ! getent group "$SERVICE_USER" >/dev/null; then
  groupadd --system "$SERVICE_USER"
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_USER" --home-dir "$GATEWAY_DIR" \
    --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
chown root:"$SERVICE_USER" "$GATEWAY_DIR" "$RELEASES_DIR"
chmod 755 "$GATEWAY_DIR" "$RELEASES_DIR"

# Adopt the old flat layout as a versioned release once. The running process
# keeps its mapped executable; the rewritten unit can safely restore this copy.
if [[ -L "$CURRENT_LINK" ]]; then
  previous_target="$(readlink -f -- "$CURRENT_LINK")"
  if [[ ! -x "$previous_target/flora-api" ]]; then
    echo "current release has no executable flora-api: $previous_target" >&2
    exit 1
  fi
elif [[ -e "$CURRENT_LINK" ]]; then
  echo "$CURRENT_LINK exists but is not a symlink" >&2
  exit 1
elif [[ -x "$GATEWAY_DIR/flora-api" ]]; then
  legacy_release="$RELEASES_DIR/legacy-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  install -d -o root -g "$SERVICE_USER" -m 755 "$legacy_release"
  install -o root -g "$SERVICE_USER" -m 755 \
    "$GATEWAY_DIR/flora-api" "$legacy_release/flora-api"
  if [[ -x "$GATEWAY_DIR/flora-migrate" ]]; then
    install -o root -g "$SERVICE_USER" -m 755 \
      "$GATEWAY_DIR/flora-migrate" "$legacy_release/flora-migrate"
  fi
  if [[ -f "$GATEWAY_DIR/flora-versions.json" ]]; then
    install -o root -g "$SERVICE_USER" -m 644 \
      "$GATEWAY_DIR/flora-versions.json" "$legacy_release/flora-versions.json"
  fi
  atomic_symlink "$legacy_release" "$CURRENT_LINK"
  previous_target="$legacy_release"
fi

if [[ -e "$RELEASE_DIR" ]]; then
  echo "release already exists: $RELEASE_DIR" >&2
  exit 1
fi
install -d -o root -g "$SERVICE_USER" -m 755 "$RELEASE_TMP"
install -o root -g "$SERVICE_USER" -m 755 \
  "$PAYLOAD/flora-api" "$RELEASE_TMP/flora-api"
install -o root -g "$SERVICE_USER" -m 755 \
  "$PAYLOAD/flora-migrate" "$RELEASE_TMP/flora-migrate"
printf '%s\n' 'retry-safe-refresh-v1' >"$RELEASE_TMP/$REPLAY_CAPABILITY_MARKER"
chown root:"$SERVICE_USER" "$RELEASE_TMP/$REPLAY_CAPABILITY_MARKER"
chmod 644 "$RELEASE_TMP/$REPLAY_CAPABILITY_MARKER"
if [[ -f "$PAYLOAD/flora-versions.json" ]]; then
  install -o root -g "$SERVICE_USER" -m 644 \
    "$PAYLOAD/flora-versions.json" "$RELEASE_TMP/flora-versions.json"
elif [[ -n "$previous_target" && -f "$previous_target/flora-versions.json" ]]; then
  install -o root -g "$SERVICE_USER" -m 644 \
    "$previous_target/flora-versions.json" "$RELEASE_TMP/flora-versions.json"
fi
mv -- "$RELEASE_TMP" "$RELEASE_DIR"
RELEASE_TMP=
atomic_symlink "$RELEASE_DIR" "$STAGED_LINK"

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

# Phase 5 gateway env (no DotnetUpstream). Auth feature flags and replay keys
# stay in flora-api.env and are never rewritten or removed by this installer.
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
Environment=FLORA_VERSIONS_PATH=/opt/flora-ecosystem/runtime/gateway/current/flora-versions.json
EnvironmentFile=-/etc/flora-ecosystem/flora-api-cors.env
EnvironmentFile=-/etc/flora-ecosystem/flora-api.env
EnvironmentFile=-/etc/flora-ecosystem/flora-gateway.env
ExecStart=/opt/flora-ecosystem/runtime/gateway/current/flora-api
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
Description=Flora module database migrations for current release
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
ExecStart=/opt/flora-ecosystem/runtime/gateway/current/flora-migrate
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

cat >/etc/systemd/system/flora-migrate-staging.service <<'EOF'
[Unit]
Description=Flora module database migrations for staged release
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
ExecStart=/opt/flora-ecosystem/runtime/gateway/staged/flora-migrate
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

# Run the migrator from the staged release while `current` and the live process
# still refer to the previous release. Only migration success permits cutover.
echo "Applying Flora module migrations from staged release $RELEASE_ID ..."
systemctl reset-failed flora-migrate-staging >/dev/null 2>&1 || true
if ! systemctl start flora-migrate-staging; then
  journalctl -u flora-migrate-staging --no-pager -n 100 >&2 || true
  echo "Staging migration failed; current API was not switched." >&2
  exit 1
fi
echo "Flora module migrations applied."

# Retire Phase 0 .NET upstream if still present.
if systemctl list-unit-files flora-api-dotnet.service >/dev/null 2>&1; then
  systemctl disable --now flora-api-dotnet >/dev/null 2>&1 || true
fi

if [[ -n "$previous_target" ]]; then
  atomic_symlink "$previous_target" "$PREVIOUS_LINK"
fi
atomic_symlink "$RELEASE_DIR" "$CURRENT_LINK"
switched=1

systemctl enable flora-api >/dev/null 2>&1 || true
systemctl restart flora-api
wait_for_health "Flora API $RELEASE_ID"
curl --silent --show-error --fail \
  --connect-timeout 2 \
  --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" \
  "$VERSION_URL"
echo

completed=1
cleanup_staged_link
echo "Flora API release $RELEASE_ID is active on :5290"
echo "Current: $RELEASE_DIR"
if [[ -n "$previous_target" ]]; then
  echo "Previous: $previous_target"
fi
