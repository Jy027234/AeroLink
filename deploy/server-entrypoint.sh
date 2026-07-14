#!/bin/sh
set -eu

mkdir -p /app/prisma/data /app/uploads

schema_path="${PRISMA_SCHEMA_PATH:-prisma/schema.prisma}"

if [ "${SKIP_SCHEMA_PREFLIGHT:-false}" != "true" ]; then
  npm run db:preflight:order-uniqueness
fi

npx prisma db push --schema "$schema_path"

if [ "${SEED_DEMO_DATA:-false}" = "true" ]; then
  npm run db:seed
fi

exec npm start
