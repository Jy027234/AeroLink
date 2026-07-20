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
worker_ref="$(read_record WORKER_ROLLBACK_REF)"
web_ref="$(read_record WEB_ROLLBACK_REF)"
rollback_worker_enabled="$(read_record ROLLBACK_WORKER_ENABLED)"
# Records created before P2-05 represent the inline-worker architecture.
rollback_worker_enabled="${rollback_worker_enabled:-false}"
[[ "$rollback_worker_enabled" == true || "$rollback_worker_enabled" == false ]] || { echo "Invalid rollback worker mode" >&2; exit 1; }
[[ "$backend_ref" == *:rollback-* ]] || { echo "Invalid backend rollback ref" >&2; exit 1; }
[[ "$web_ref" == *:rollback-* ]] || { echo "Invalid web rollback ref" >&2; exit 1; }
docker image inspect "$backend_ref" >/dev/null 2>&1
docker image inspect "$web_ref" >/dev/null 2>&1
if [[ "$rollback_worker_enabled" == true ]]; then
  [[ "$worker_ref" == *:rollback-* ]] || { echo "Invalid worker rollback ref" >&2; exit 1; }
  docker image inspect "$worker_ref" >/dev/null 2>&1
fi

backend_image="${backend_ref%%:rollback-*}"
web_image="${web_ref%%:rollback-*}"
docker tag "$backend_ref" "$backend_image:latest"
docker tag "$web_ref" "$web_image:latest"
worker_image="$backend_image"
if [[ "$rollback_worker_enabled" == true ]]; then
  worker_image="${worker_ref%%:rollback-*}"
  docker tag "$worker_ref" "$worker_image:latest"
fi
export BACKEND_IMAGE="$backend_image" WORKER_IMAGE="$worker_image" WEB_IMAGE="$web_image" IMAGE_TAG=latest
compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
"${compose[@]}" stop -t 45 worker || true
rollback_services=(backend web)
if [[ "$rollback_worker_enabled" == true ]]; then
  rollback_services+=(worker)
fi
"${compose[@]}" up -d --no-build "${rollback_services[@]}"

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
