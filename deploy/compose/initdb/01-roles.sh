#!/bin/sh
# Runs once when the Postgres volume is initialised. Creates the runtime roles WITH passwords
# (tenancy-db ensureRoles creates them without passwords when missing, which only suits trust-auth dev clusters).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$APP_DB_PASSWORD" -v sys_pw="$SYSTEM_DB_PASSWORD" <<'SQL'
create role platform_app login nobypassrls nosuperuser password :'app_pw';
create role platform_system login bypassrls nosuperuser password :'sys_pw';
create extension if not exists vector;
SQL
