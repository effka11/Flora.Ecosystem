#!/bin/bash
# DEPRECATED (Phase 0 dual-stack). Use Phase 5 installer instead:
#   Scripts/deploy-flora-api.ps1   (from workstation)
#   Scripts/remote-install-flora-api.sh  (on VPS after binary is staged)
#
# This script kept only as a pointer — do not run for production cutover.
set -euo pipefail
echo "deploy-phase0-gateway.sh is obsolete (Phase 5: Rust flora-api only)." >&2
echo "Use: pwsh ./Scripts/deploy-flora-api.ps1" >&2
exit 1
