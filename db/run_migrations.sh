#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "Usage: DATABASE_URL=postgresql://... ./run_migrations.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/migrations"

echo "Running migrations against: ${DATABASE_URL%%@*}@***"
echo ""

for file in "$MIGRATIONS_DIR"/*.sql; do
  filename=$(basename "$file")
  echo "  Applying $filename ..."
  psql "$DATABASE_URL" -f "$file" --quiet --set ON_ERROR_STOP=on
done

echo ""
echo "All migrations applied successfully."
