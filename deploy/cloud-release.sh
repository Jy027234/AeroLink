#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
RELEASE_TAG="${RELEASE_TAG:?RELEASE_TAG is required and must be the full Git SHA}"
SOURCE_REF="${SOURCE_REF:?SOURCE_REF is required and must be the full Git SHA}"
BACKEND_IMAGE="${BACKEND_IMAGE:-aerolink-prod-backend}"
WEB_IMAGE="${WEB_IMAGE:-aerolink-prod-web}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/api/health}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-90}"
RECORD_DIR="${RECORD_DIR:-$PROJECT_DIR/deploy/releases}"
SBOM_DIR="${SBOM_DIR:?SBOM_DIR is required and must contain the Build and Verify artifact}"
RELEASE_MANIFEST="${RELEASE_MANIFEST:-$SBOM_DIR/release-manifest.env}"

require_full_sha() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[0-9a-f]{40}$ ]]; then
    echo "$label must be a 40-character lowercase Git SHA." >&2
    exit 1
  fi
}

read_manifest_value() {
  local key="$1"
  local count
  count="$(grep -c "^${key}=" "$RELEASE_MANIFEST" || true)"
  if [[ "$count" != 1 ]]; then
    echo "Release manifest must contain exactly one ${key} entry." >&2
    exit 1
  fi
  sed -n "s/^${key}=//p" "$RELEASE_MANIFEST"
}

require_image() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "Missing release image: $image" >&2
    exit 1
  }
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 "$SMOKE_TIMEOUT_SECONDS"); do
    if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

set_record_status() {
  local status="$1"
  sed -i "s/^STATUS=.*/STATUS=${status}/" "$record_file"
}

require_full_sha "$RELEASE_TAG" "RELEASE_TAG"
require_full_sha "$SOURCE_REF" "SOURCE_REF"
if [[ "$RELEASE_TAG" != "$SOURCE_REF" ]]; then
  echo "RELEASE_TAG and SOURCE_REF must be the same full Git SHA." >&2
  exit 1
fi

[[ -d "$SBOM_DIR" ]] || { echo "SBOM_DIR does not exist: $SBOM_DIR" >&2; exit 1; }
SBOM_DIR="$(CDPATH= cd -- "$SBOM_DIR" && pwd)"
[[ -s "$SBOM_DIR/backend.sbom.spdx.json" ]] || { echo "Missing backend SBOM: $SBOM_DIR/backend.sbom.spdx.json" >&2; exit 1; }
[[ -s "$SBOM_DIR/frontend.sbom.spdx.json" ]] || { echo "Missing frontend SBOM: $SBOM_DIR/frontend.sbom.spdx.json" >&2; exit 1; }
[[ -s "$RELEASE_MANIFEST" ]] || { echo "Missing release manifest: $RELEASE_MANIFEST" >&2; exit 1; }
RELEASE_MANIFEST="$(CDPATH= cd -- "$(dirname -- "$RELEASE_MANIFEST")" && pwd)/$(basename -- "$RELEASE_MANIFEST")"

manifest_source_ref="$(read_manifest_value SOURCE_REF)"
manifest_release_tag="$(read_manifest_value RELEASE_TAG)"
if [[ "$manifest_source_ref" != "$SOURCE_REF" || "$manifest_release_tag" != "$RELEASE_TAG" ]]; then
  echo "Release manifest does not match SOURCE_REF and RELEASE_TAG." >&2
  exit 1
fi

cd "$PROJECT_DIR"
mkdir -p "$RECORD_DIR"
chmod 700 "$RECORD_DIR"

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$RELEASE_TAG"
record_file="$RECORD_DIR/$run_id.env"
backend_rollback_ref="$BACKEND_IMAGE:rollback-$run_id"
web_rollback_ref="$WEB_IMAGE:rollback-$run_id"
db_backup="$RECORD_DIR/$run_id.postgres.sql.gz"
backend_sbom="$RECORD_DIR/$run_id.backend.spdx.json"
frontend_sbom="$RECORD_DIR/$run_id.frontend.spdx.json"
release_manifest="$RECORD_DIR/$run_id.manifest.env"

previous_backend_id="$(docker image inspect "$BACKEND_IMAGE:latest" --format '{{.Id}}' 2>/dev/null || true)"
previous_web_id="$(docker image inspect "$WEB_IMAGE:latest" --format '{{.Id}}' 2>/dev/null || true)"
require_image "$BACKEND_IMAGE:$RELEASE_TAG"
require_image "$WEB_IMAGE:$RELEASE_TAG"
release_backend_id="$(docker image inspect "$BACKEND_IMAGE:$RELEASE_TAG" --format '{{.Id}}')"
release_web_id="$(docker image inspect "$WEB_IMAGE:$RELEASE_TAG" --format '{{.Id}}')"

cp "$SBOM_DIR/backend.sbom.spdx.json" "$backend_sbom"
cp "$SBOM_DIR/frontend.sbom.spdx.json" "$frontend_sbom"
cp "$RELEASE_MANIFEST" "$release_manifest"
chmod 600 "$backend_sbom" "$frontend_sbom" "$release_manifest"

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
SOURCE_REF=$SOURCE_REF
SOURCE_MANIFEST=$release_manifest
BACKEND_ROLLBACK_REF=$backend_rollback_ref
WEB_ROLLBACK_REF=$web_rollback_ref
BACKEND_RELEASE_IMAGE=$BACKEND_IMAGE:$RELEASE_TAG
WEB_RELEASE_IMAGE=$WEB_IMAGE:$RELEASE_TAG
BACKEND_RELEASE_ID=$release_backend_id
WEB_RELEASE_ID=$release_web_id
DB_BACKUP=$db_backup
BACKEND_SBOM=$backend_sbom
FRONTEND_SBOM=$frontend_sbom
STATUS=starting
EOF
chmod 600 "$record_file"

rollback() {
  trap - ERR
  echo "Release verification failed; restoring previous images." >&2
  if [[ -z "$previous_backend_id" || -z "$previous_web_id" ]]; then
    set_record_status "rollback_unavailable"
    echo "No previous backend/web image pair is available for automatic rollback." >&2
    return 1
  fi
  if ! docker tag "$backend_rollback_ref" "$BACKEND_IMAGE:latest"; then
    set_record_status "rollback_failed"
    return 1
  fi
  if ! docker tag "$web_rollback_ref" "$WEB_IMAGE:latest"; then
    set_record_status "rollback_failed"
    return 1
  fi
  if ! "${compose[@]}" up -d --no-build backend web >/dev/null; then
    set_record_status "rollback_failed"
    return 1
  fi
  if wait_for_health; then
    set_record_status "rolled_back"
    return 0
  fi
  set_record_status "rollback_failed"
  return 1
}
trap 'rollback' ERR

docker tag "$BACKEND_IMAGE:$RELEASE_TAG" "$BACKEND_IMAGE:latest"
docker tag "$WEB_IMAGE:$RELEASE_TAG" "$WEB_IMAGE:latest"
"${compose[@]}" up -d --no-build backend web

if ! wait_for_health; then
  echo "Release health check timed out: $HEALTH_URL" >&2
  rollback
  exit 1
fi

if ! PROJECT_DIR="$PROJECT_DIR" COMPOSE_FILE="$COMPOSE_FILE" ENV_FILE="$ENV_FILE" \
  HEALTH_URL="$HEALTH_URL" RELEASE_RECORD="$record_file" SOURCE_REF="$SOURCE_REF" \
  bash "$PROJECT_DIR/deploy/cloud-verify.sh"; then
  rollback
  exit 1
fi

trap - ERR
set_record_status "verified"
echo "Release verified: $RELEASE_TAG"
echo "Release record: $record_file"
