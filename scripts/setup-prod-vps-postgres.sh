#!/bin/bash
# PostgreSQL for Flora.API on Ubuntu VPS (FirstVDS etc.). Run as root.
set -euo pipefail

DB_NAME="${DB_NAME:-flora_social}"
DB_USER="${DB_USER:-flora}"
DB_PASS="${DB_PASS:-}"

if [[ -z "$DB_PASS" ]]; then
  DB_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y postgresql postgresql-contrib

systemctl enable postgresql
systemctl start postgresql

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
SQL

sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" <<'SQL'
CREATE SCHEMA IF NOT EXISTS flora_core;
GRANT ALL ON SCHEMA flora_core TO flora;
ALTER ROLE flora SET search_path TO flora_core, public;
SQL

mkdir -p /etc/flora-ecosystem
echo "DB_PASS=$DB_PASS"
