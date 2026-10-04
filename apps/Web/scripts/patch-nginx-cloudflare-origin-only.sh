#!/usr/bin/env bash
# Restrict social/origin/gov nginx vhosts to Cloudflare origin-pull IPs.
# Do not run this until Web SSE is same-origin on social.* (otherwise live
# browsers still calling origin.flora-s.net will get 403).
set -euo pipefail

snippet=/etc/nginx/snippets/flora-cloudflare-origin-only.conf
mkdir -p /etc/nginx/snippets
cat >"$snippet" <<'EOF'
# Cloudflare anycast → this VPS (orange social.* / gov.* origin pull).
# Direct clients (including networks where CF is blocked) get 403.
# Source: https://www.cloudflare.com/ips-v4 and /ips-v6 (2026-08-27).
allow 173.245.48.0/20;
allow 103.21.244.0/22;
allow 103.22.200.0/22;
allow 103.31.4.0/22;
allow 141.101.64.0/18;
allow 108.162.192.0/18;
allow 190.93.240.0/20;
allow 188.114.96.0/20;
allow 197.234.240.0/22;
allow 198.41.128.0/17;
allow 162.158.0.0/15;
allow 104.16.0.0/13;
allow 104.24.0.0/14;
allow 172.64.0.0/13;
allow 131.0.72.0/22;
allow 2400:cb00::/32;
allow 2606:4700::/32;
allow 2803:f800::/32;
allow 2405:b500::/32;
allow 2405:8100::/32;
allow 2a06:98c0::/29;
allow 2c0f:f248::/32;
allow 127.0.0.1;
allow ::1;
deny all;
EOF

python3 - <<'PY'
from pathlib import Path

INCLUDE = "    include /etc/nginx/snippets/flora-cloudflare-origin-only.conf;\n"
files = [
    Path("/etc/nginx/sites-available/flora-web.conf"),
    Path("/etc/nginx/sites-available/flora-origin-https.conf"),
    Path("/etc/nginx/sites-available/flora-gov.conf"),
    Path("/etc/nginx/sites-available/flora-gov-https.conf"),
]
for path in files:
    if not path.is_file():
        print("skip missing", path.name)
        continue
    text = path.read_text()
    if "flora-cloudflare-origin-only.conf" in text:
        print("skip", path.name, "(already gated)")
        continue
    lines = text.splitlines(keepends=True)
    out = []
    inserted = False
    for line in lines:
        out.append(line)
        if not inserted and line.lstrip().startswith("server_name "):
            out.append("\n")
            out.append(INCLUDE)
            inserted = True
        if "location /.well-known/acme-challenge/" in line:
            # next non-empty inside block should allow all for certbot
            pass
    text2 = "".join(out)
    text2 = text2.replace(
        "    location /.well-known/acme-challenge/ {\n        root /var/www/certbot;",
        "    location /.well-known/acme-challenge/ {\n        allow all;\n        root /var/www/certbot;",
    )
    path.write_text(text2)
    print("patched", path.name)
PY

nginx -t
systemctl reload nginx
echo "nginx Cloudflare origin-only gate OK"
