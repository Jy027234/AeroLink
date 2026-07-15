#!/bin/sh
set -eu

mkdir -p /app/prisma/data /app/uploads

schema_path="${PRISMA_SCHEMA_PATH:-prisma/schema.prisma}"
schema_mode="${SCHEMA_MIGRATION_MODE:-migrate}"

if [ "${NODE_ENV:-production}" = "production" ] && [ "${REQUIRE_SECURE_ORIGIN:-true}" = "true" ]; then
  old_ifs="$IFS"
  IFS=','
  set -- ${CLIENT_URL:-}
  IFS="$old_ifs"
  if [ "$#" -eq 0 ]; then
    echo "Refusing production startup: CLIENT_URL must use https:// when secure cookies are enabled."
    echo "Terminate TLS at the TLS profile or an upstream proxy, then set CLIENT_URL to the public HTTPS origin."
    exit 1
  fi
  for origin in "$@"; do
    case "$origin" in
      https://*) ;;
      *)
        echo "Refusing production startup: every CLIENT_URL origin must use https:// when secure cookies are enabled."
        echo "Terminate TLS at the TLS profile or an upstream proxy, then set CLIENT_URL to public HTTPS origins."
        exit 1
        ;;
    esac
  done
fi

if [ "${SKIP_SCHEMA_PREFLIGHT:-false}" != "true" ]; then
  npm run db:preflight:order-uniqueness
fi

case "$schema_mode" in
  migrate)
    if [ "${MIGRATION_BASELINE_CONFIRMED:-false}" != "true" ]; then
      echo "MIGRATION_BASELINE_CONFIRMED=true is required before production migration deploy."
      echo "Resolve the existing database baseline in a backup/staging environment first."
      exit 1
    fi
    npx prisma migrate deploy --schema "$schema_path"
    ;;
  push)
    if [ "${NODE_ENV:-production}" = "production" ] && [ "${ALLOW_DB_PUSH:-false}" != "true" ]; then
      echo "Refusing prisma db push in production. Set SCHEMA_MIGRATION_MODE=migrate after baseline preparation."
      exit 1
    fi
    npx prisma db push --schema "$schema_path"
    ;;
  *)
    echo "Unsupported SCHEMA_MIGRATION_MODE: $schema_mode (expected migrate or push)."
    exit 1
    ;;
esac

if [ "${SEED_DEMO_DATA:-false}" = "true" ]; then
  if [ "${NODE_ENV:-production}" = "production" ] && [ "${ALLOW_PRODUCTION_DEMO_SEED:-false}" != "true" ]; then
    echo "Refusing demo seed in production without ALLOW_PRODUCTION_DEMO_SEED=true."
    exit 1
  fi
  npm run db:seed
fi

if [ "${REQUIRE_ACTIVE_ADMIN:-true}" = "true" ]; then
  npm run db:check-active-admin
fi

exec npm start
