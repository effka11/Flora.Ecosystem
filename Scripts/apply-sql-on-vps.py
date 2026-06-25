#!/usr/bin/env python3
import re
import subprocess
import sys
from pathlib import Path

env_path = Path("/etc/flora-ecosystem/flora-api.env")
sql_path = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/notifications-client-platforms.sql")

raw = env_path.read_text()
match = re.search(r"^ConnectionStrings__FloraDatabase=(.+)$", raw, re.M)
if not match:
    raise SystemExit("ConnectionStrings__FloraDatabase not found")
conn = match.group(1).strip()
parts = {}
for segment in conn.split(";"):
    segment = segment.strip()
    if not segment or "=" not in segment:
        continue
    key, value = segment.split("=", 1)
    parts[key.strip().lower()] = value.strip()

pg_args = [
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    parts.get("host", "127.0.0.1"),
    "-p",
    parts.get("port", "5432"),
    "-U",
    parts.get("username") or parts.get("user") or "flora",
    "-d",
    parts.get("database") or parts.get("dbname") or "flora_social",
    "-f",
    str(sql_path),
]
env = {"PGPASSWORD": parts.get("password", "")}

result = subprocess.run(
    pg_args,
    capture_output=True,
    text=True,
    env={**subprocess.os.environ, **env},
)
print(result.stdout)
if result.returncode != 0:
    print(result.stderr, file=sys.stderr)
    raise SystemExit(result.returncode)
print("SQL applied OK")
