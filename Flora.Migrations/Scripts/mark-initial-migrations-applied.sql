-- Use when the flora_core schema already matches the model (e.g. deployed from flora_social_schema.sql).
-- Replace <MigrationId_*> with the MigrationId from each generated Initial migration class filename
-- (e.g. 20260421120000_Initial) and <ProductVersion> with your EF Core version (e.g. 10.0.2).
--
-- Creates per-context history tables (same names as UseNpgsql MigrationsHistoryTable).

CREATE SCHEMA IF NOT EXISTS flora_core;

CREATE TABLE IF NOT EXISTS flora_core."__EFMigrationsHistory_Auth" (
    "MigrationId" character varying(150) NOT NULL PRIMARY KEY,
    "ProductVersion" character varying(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS flora_core."__EFMigrationsHistory_Users" (
    "MigrationId" character varying(150) NOT NULL PRIMARY KEY,
    "ProductVersion" character varying(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS flora_core."__EFMigrationsHistory_Content" (
    "MigrationId" character varying(150) NOT NULL PRIMARY KEY,
    "ProductVersion" character varying(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS flora_core."__EFMigrationsHistory_Messaging" (
    "MigrationId" character varying(150) NOT NULL PRIMARY KEY,
    "ProductVersion" character varying(32) NOT NULL
);

INSERT INTO flora_core."__EFMigrationsHistory_Auth" ("MigrationId", "ProductVersion")
VALUES ('<MigrationId_Auth>', '<ProductVersion>')
ON CONFLICT ("MigrationId") DO NOTHING;

INSERT INTO flora_core."__EFMigrationsHistory_Users" ("MigrationId", "ProductVersion")
VALUES ('<MigrationId_Users>', '<ProductVersion>')
ON CONFLICT ("MigrationId") DO NOTHING;

INSERT INTO flora_core."__EFMigrationsHistory_Content" ("MigrationId", "ProductVersion")
VALUES ('<MigrationId_Content>', '<ProductVersion>')
ON CONFLICT ("MigrationId") DO NOTHING;

INSERT INTO flora_core."__EFMigrationsHistory_Messaging" ("MigrationId", "ProductVersion")
VALUES ('<MigrationId_Messaging>', '<ProductVersion>')
ON CONFLICT ("MigrationId") DO NOTHING;
