-- Local development DB bootstrap (run once as a PostgreSQL superuser), e.g.:
--   psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -f Flora.API/cursor-temp-bootstrap.sql
--
-- Copy this file to cursor-temp-bootstrap.sql, replace the placeholder password
-- with the value you put in appsettings.Local.json, then run it. The real file is
-- gitignored so the password never lands in version control.
CREATE ROLE "cursor-temp" LOGIN PASSWORD '__LOCAL_DB_PASSWORD__';
GRANT CONNECT ON DATABASE flora_social TO "cursor-temp";
\c flora_social
GRANT USAGE ON SCHEMA flora_core TO "cursor-temp";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA flora_core TO "cursor-temp";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA flora_core TO "cursor-temp";
ALTER DEFAULT PRIVILEGES IN SCHEMA flora_core GRANT ALL ON TABLES TO "cursor-temp";
ALTER DEFAULT PRIVILEGES IN SCHEMA flora_core GRANT ALL ON SEQUENCES TO "cursor-temp";
