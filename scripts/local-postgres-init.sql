-- Выполняется один раз при первом старте контейнера (docker-entrypoint-initdb.d).
CREATE SCHEMA IF NOT EXISTS flora_core;
GRANT ALL ON SCHEMA flora_core TO flora;
ALTER ROLE flora SET search_path TO flora_core, public;
