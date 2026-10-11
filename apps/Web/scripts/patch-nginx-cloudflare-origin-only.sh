#!/usr/bin/env bash
# DNS points at this VPS. Do not install the Cloudflare origin allowlist.
echo "Refusing to install the Cloudflare origin allowlist: the domain points at this VPS." >&2
exit 1
