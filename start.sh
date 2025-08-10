#!/bin/sh
set -euo pipefail

# Map DATABASE_URL to DB_URL if only DATABASE_URL is set
if [ -n "${DATABASE_URL:-}" ] && [ -z "${DB_URL:-}" ]; then
  export DB_URL="$DATABASE_URL"
fi

echo "[start] Running prisma db push..."
npx prisma db push --accept-data-loss || { echo "Prisma db push failed"; exit 1; }

echo "[start] Launching server..."
exec node src/server.js
