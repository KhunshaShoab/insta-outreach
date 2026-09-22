#!/usr/bin/env bash
# Apply every migration to a scratch database and run the lifecycle test.
# Usage: PGURL=postgresql://... scripts/db-test.sh    (defaults to a local socket)
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL=${PSQL:-psql}
HOST=${PGHOST:-/tmp}
PORT=${PGPORT:-55432}
USER=${PGUSER:-postgres}
DB=${PGDATABASE:-optiflow_test}

run() { $PSQL -h "$HOST" -p "$PORT" -U "$USER" "$@"; }

run -d postgres -c "drop database if exists $DB;" -c "create database $DB;" >/dev/null
for f in db/migrations/*.sql db/seed/*.sql; do
  echo "applying $f"
  run -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 | grep -v '^psql.*NOTICE' || true
done
echo "running lifecycle test"
run -d "$DB" -v ON_ERROR_STOP=1 -f db/tests/lifecycle_test.sql 2>&1 | sed -n 's/.*NOTICE: */  /p'
echo "OK"
