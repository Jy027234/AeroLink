#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
RELEASE_TAG="${RELEASE_TAG:?RELEASE_TAG is required}"
BACKEND_IMAGE="${BACKEND_IMAGE:-aerolink-prod-backend}"
WEB_IMAGE="${WEB_IMAGE:-aerolink-prod-web}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/api/health}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-90}"
RECORD_DIR="${RECORD_DIR:-$PROJECT_DIR/deploy/releases}"
SBOM_DIR="${SBOM_DIR:-}"
REQUIRE_SBOM="${REQUIRE_SBOM:-false}"

cd "$PROJECT_DIR"
mkdir -p "$RECORD_DIR"
chmod 700 "$RECORD_DIR"

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$RELEASE_TAG"
record_file="$RECORD_DIR/$run_id.env"
backend_rollback_ref="$BACKEND_IMAGE:rollback-$run_id"
web_rollback_ref="$WEB_IMAGE:rollback-$run_id"
db_backup="$RECORD_DIR/$run_id.postgres.sql.gz"

require_image() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "Missing release image: $image" >&2
    exit 1
  }
}

previous_backend_id="$(docker image inspect "$BACKEND_IMAGE:latest" --format '{{.Id}}' 2>/dev/null || true)"
previous_web_id="$(docker image inspect "$WEB_IMAGE:latest" --format '{{.Id}}' 2>/dev/null || true)"
require_image "$BACKEND_IMAGE:$RELEASE_TAG"
require_image "$WEB_IMAGE:$RELEASE_TAG"
release_backend_id="$(docker image inspect "$BACKEND_IMAGE:$RELEASE_TAG" --format '{{.Id}}')"
release_web_id="$(docker image inspect "$WEB_IMAGE:$RELEASE_TAG" --format '{{.Id}}')"

if [[ "$REQUIRE_SBOM" == true && -z "$SBOM_DIR" ]]; then
  echo "SBOM_DIR is required when REQUIRE_SBOM=true." >&2
  exit 1
fi
backend_sbom=""
frontend_sbom=""
if [[ -n "$SBOM_DIR" ]]; then
  backend_sbom="$RECORD_DIR/$run_id.backend.spdx.json"
  frontend_sbom="$RECORD_DIR/$run_id.frontend.spdx.json"
  [[ -s "$SBOM_DIR/backend.spdx.json" ]] || { echo "Missing backend SBOM" >&2; exit 1; }
  [[ -s "$SBOM_DIR/frontend.spdx.json" ]] || { echo "Missing frontend SBOM" >&2; exit 1; }
  cp "$SBOM_DIR/backend.spdx.json" "$backend_sbom"
  cp "$SBOM_DIR/frontend.spdx.json" "$frontend_sbom"
  chmod 600 "$backend_sbom" "$frontend_sbom"
fi

if ! "${compose[@]}" exec -T postgres pg_dump -U aerolink -d aerolink | gzip -c >"$db_backup"; then
  rm -f "$db_backup"
  echo "Database backup failed; release aborted." >&2
  exit 1
fi
gzip -t "$db_backup"
chmod 600 "$db_backup"

if [[ -n "$previous_backend_id" ]]; then
  docker tag "$previous_backend_id" "$backend_rollback_ref"
fi
if [[ -n "$previous_web_id" ]]; then
  docker tag "$previous_web_id" "$web_rollback_ref"
fi

cat >"$record_file" <<EOF
RELEASE_TAG=$RELEASE_TAG
RUN_ID=$run_id
BACKEND_ROLLBACK_REF=$backend_rollback_ref
WEB_ROLLBACK_REF=$web_rollback_ref
BACKEND_RELEASE_IMAGE=$BACKEND_IMAGE:$RELEASE_TAG
WEB_RELEASE_IMAGE=$WEB_IMAGE:$RELEASE_TAG
BACKEND_RELEASE_ID=$release_backend_id
WEB_RELEASE_ID=$release_web_id
SOURCE_REF=${SOURCE_REF:-cloud-test-workspace}
DB_BACKUP=$db_backup
BACKEND_SBOM=$backend_sbom
FRONTEND_SBOM=$frontend_sbom
STATUS=starting
EOF
chmod 600 "$record_file"

rollback() {
  trap - ERR
  echo "Release smoke check failed; restoring previous images." >&2
  if [[ -n "$previous_backend_id" ]]; then
    docker tag "$backend_rollback_ref" "$BACKEND_IMAGE:latest"
  fi
  if [[ -n "$previous_web_id" ]]; then
    docker tag "$web_rollback_ref" "$WEB_IMAGE:latest"
  fi
  "${compose[@]}" up -d --no-build backend web >/dev/null
  sed -i 's/^STATUS=.*/STATUS=rolled_back/' "$record_file"
}
trap 'rollback' ERR

docker tag "$BACKEND_IMAGE:$RELEASE_TAG" "$BACKEND_IMAGE:latest"
docker tag "$WEB_IMAGE:$RELEASE_TAG" "$WEB_IMAGE:latest"
"${compose[@]}" up -d --no-build backend web

healthy=false
for _ in $(seq 1 "$SMOKE_TIMEOUT_SECONDS"); do
  if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done

if [[ "$healthy" != true ]]; then
  echo "Release health check timed out: $HEALTH_URL" >&2
  rollback
  exit 1
fi

trap - ERR
sed -i 's/^STATUS=.*/STATUS=deployed/' "$record_file"
echo "Release deployed: $RELEASE_TAG"
echo "Release record: $record_file"
