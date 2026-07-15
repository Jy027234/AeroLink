#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
RELEASE_RECORD="${RELEASE_RECORD:?RELEASE_RECORD is required}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/api/health}"

cd "$PROJECT_DIR"
[[ -f "$RELEASE_RECORD" ]] || { echo "Release record not found: $RELEASE_RECORD" >&2; exit 1; }

read_record() {
  sed -n "s/^$1=//p" "$RELEASE_RECORD" | head -n 1
}

backend_ref="$(read_record BACKEND_ROLLBACK_REF)"
web_ref="$(read_record WEB_ROLLBACK_REF)"
[[ "$backend_ref" == aerolink-prod-backend:rollback-* ]] || { echo "Invalid backend rollback ref" >&2; exit 1; }
[[ "$web_ref" == aerolink-prod-web:rollback-* ]] || { echo "Invalid web rollback ref" >&2; exit 1; }
docker image inspect "$backend_ref" >/dev/null 2>&1
docker image inspect "$web_ref" >/dev/null 2>&1

docker tag "$backend_ref" aerolink-prod-backend:latest
docker tag "$web_ref" aerolink-prod-web:latest
compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
"${compose[@]}" up -d --no-build backend web

for _ in $(seq 1 90); do
  if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null; then
    sed -i 's/^STATUS=.*/STATUS=rolled_back_manual/' "$RELEASE_RECORD"
    echo "Rollback completed: $RELEASE_RECORD"
    exit 0
  fi
  sleep 1
done

echo "Rollback health check timed out: $HEALTH_URL" >&2
exit 1
