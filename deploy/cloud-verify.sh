#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/api/health}"
RELEASE_RECORD="${RELEASE_RECORD:?RELEASE_RECORD is required}"
SOURCE_REF="${SOURCE_REF:?SOURCE_REF is required and must be the full Git SHA}"
WORKER_STABILITY_WINDOW_SECONDS="${WORKER_STABILITY_WINDOW_SECONDS:-5}"
WORKER_STABILITY_MIN_WINDOW_SECONDS=2
WORKER_STABILITY_MAX_WINDOW_SECONDS=30

require_full_sha() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[0-9a-f]{40}$ ]]; then
    echo "$label must be a 40-character lowercase Git SHA." >&2
    exit 1
  fi
}

validate_worker_stability_window() {
  if [[ ! "$WORKER_STABILITY_WINDOW_SECONDS" =~ ^[0-9]{1,2}$ ]]; then
    echo "WORKER_STABILITY_WINDOW_SECONDS must be an integer between ${WORKER_STABILITY_MIN_WINDOW_SECONDS} and ${WORKER_STABILITY_MAX_WINDOW_SECONDS}; worker stability checks cannot be disabled." >&2
    exit 1
  fi

  local window_seconds=$((10#$WORKER_STABILITY_WINDOW_SECONDS))
  if (( window_seconds < WORKER_STABILITY_MIN_WINDOW_SECONDS || window_seconds > WORKER_STABILITY_MAX_WINDOW_SECONDS )); then
    echo "WORKER_STABILITY_WINDOW_SECONDS must be an integer between ${WORKER_STABILITY_MIN_WINDOW_SECONDS} and ${WORKER_STABILITY_MAX_WINDOW_SECONDS}; worker stability checks cannot be disabled." >&2
    exit 1
  fi
  WORKER_STABILITY_WINDOW_SECONDS="$window_seconds"
}

read_record_value() {
  local key="$1"
  local count
  count="$(grep -c "^${key}=" "$RELEASE_RECORD" || true)"
  if [[ "$count" != 1 ]]; then
    echo "Release record must contain exactly one ${key} entry." >&2
    exit 1
  fi
  sed -n "s/^${key}=//p" "$RELEASE_RECORD"
}

set_record_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$RELEASE_RECORD"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$RELEASE_RECORD"
  else
    printf '%s=%s\n' "$key" "$value" >> "$RELEASE_RECORD"
  fi
}

require_full_sha "$SOURCE_REF" "SOURCE_REF"
validate_worker_stability_window
[[ -s "$RELEASE_RECORD" ]] || { echo "Release record not found: $RELEASE_RECORD" >&2; exit 1; }
RELEASE_RECORD="$(CDPATH= cd -- "$(dirname -- "$RELEASE_RECORD")" && pwd)/$(basename -- "$RELEASE_RECORD")"

record_source_ref="$(read_record_value SOURCE_REF)"
record_release_tag="$(read_record_value RELEASE_TAG)"
backend_release_image="$(read_record_value BACKEND_RELEASE_IMAGE)"
worker_release_image="$(read_record_value WORKER_RELEASE_IMAGE)"
web_release_image="$(read_record_value WEB_RELEASE_IMAGE)"
backend_release_id="$(read_record_value BACKEND_RELEASE_ID)"
worker_release_id="$(read_record_value WORKER_RELEASE_ID)"
web_release_id="$(read_record_value WEB_RELEASE_ID)"

if [[ "$record_source_ref" != "$SOURCE_REF" || "$record_release_tag" != "$SOURCE_REF" ]]; then
  echo "Release record SOURCE_REF/RELEASE_TAG does not match the requested source commit." >&2
  exit 1
fi

actual_backend_id="$(docker image inspect "$backend_release_image" --format '{{.Id}}')"
actual_worker_id="$(docker image inspect "$worker_release_image" --format '{{.Id}}')"
actual_web_id="$(docker image inspect "$web_release_image" --format '{{.Id}}')"
if [[ "$actual_backend_id" != "$backend_release_id" || "$actual_worker_id" != "$worker_release_id" || "$actual_web_id" != "$web_release_id" ]]; then
  echo "Release image IDs no longer match the release record." >&2
  exit 1
fi

health_response="$(curl --fail --silent --show-error --max-time 10 "$HEALTH_URL")"
if ! printf '%s' "$health_response" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  echo "Health endpoint did not report status=ok: $HEALTH_URL" >&2
  exit 1
fi

cd "$PROJECT_DIR"
export BACKEND_IMAGE="${backend_release_image%%:*}" WORKER_IMAGE="${worker_release_image%%:*}" WEB_IMAGE="${web_release_image%%:*}" IMAGE_TAG=latest
compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

check_running_image() {
  local service="$1"
  local expected_image_id="$2"
  local container_id
  local running_image_id

  container_id="$("${compose[@]}" ps -q "$service" | tr -d '[:space:]')"
  if [[ -z "$container_id" ]]; then
    echo "${service^} service is not running after release." >&2
    exit 1
  fi
  running_image_id="$(docker inspect "$container_id" --format '{{.Image}}')"
  if [[ "$running_image_id" != "$expected_image_id" ]]; then
    echo "${service^} container image does not match the release record." >&2
    exit 1
  fi
}

check_worker_stability() {
  local container_id
  local worker_state
  local worker_running
  local worker_restarting
  local worker_restart_count
  local initial_restart_count
  local sample

  container_id="$("${compose[@]}" ps -q worker | tr -d '[:space:]')"
  if [[ -z "$container_id" ]]; then
    echo "Worker service disappeared during stability check." >&2
    exit 1
  fi

  if ! worker_state="$(docker inspect "$container_id" --format '{{.State.Running}}|{{.State.Restarting}}|{{.RestartCount}}')"; then
    echo "Could not inspect Worker container state." >&2
    exit 1
  fi
  IFS='|' read -r worker_running worker_restarting worker_restart_count <<< "$worker_state"
  if [[ "$worker_running" != true ]]; then
    echo "Worker container is not running after release." >&2
    exit 1
  fi
  if [[ "$worker_restarting" != false ]]; then
    echo "Worker container is restarting after release." >&2
    exit 1
  fi
  if [[ ! "$worker_restart_count" =~ ^[0-9]+$ ]]; then
    echo "Worker container reported an invalid restart count: ${worker_restart_count:-none}." >&2
    exit 1
  fi
  initial_restart_count="$worker_restart_count"

  for (( sample = 1; sample <= WORKER_STABILITY_WINDOW_SECONDS; sample++ )); do
    sleep 1
    if ! worker_state="$(docker inspect "$container_id" --format '{{.State.Running}}|{{.State.Restarting}}|{{.RestartCount}}')"; then
      echo "Could not inspect Worker container state during stability check." >&2
      exit 1
    fi
    IFS='|' read -r worker_running worker_restarting worker_restart_count <<< "$worker_state"
    if [[ "$worker_running" != true ]]; then
      echo "Worker container stopped during stability check." >&2
      exit 1
    fi
    if [[ "$worker_restarting" != false ]]; then
      echo "Worker container entered restarting state during stability check." >&2
      exit 1
    fi
    if [[ ! "$worker_restart_count" =~ ^[0-9]+$ ]]; then
      echo "Worker container reported an invalid restart count during stability check: ${worker_restart_count:-none}." >&2
      exit 1
    fi
    if [[ "$worker_restart_count" != "$initial_restart_count" ]]; then
      echo "Worker restart count changed during stability check: expected $initial_restart_count, got $worker_restart_count." >&2
      exit 1
    fi
  done
}

check_running_image backend "$backend_release_id"
check_running_image worker "$worker_release_id"
check_worker_stability
check_running_image web "$web_release_id"

"${compose[@]}" exec -T backend npx prisma migrate status --schema prisma/schema.prisma
expected_migration_count="$(find "$PROJECT_DIR/server/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"
if [[ ! "$expected_migration_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "Could not determine the expected Prisma migration count." >&2
  exit 1
fi
applied_migration_count="$("${compose[@]}" exec -T postgres psql -U aerolink -d aerolink -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;' | tr -d '[:space:]')"
if [[ ! "$applied_migration_count" =~ ^[0-9]+$ || "$applied_migration_count" != "$expected_migration_count" ]]; then
  echo "Migration count mismatch: expected $expected_migration_count applied migrations, got ${applied_migration_count:-none}." >&2
  exit 1
fi
"${compose[@]}" exec -T backend npm run observability:retention-check
"${compose[@]}" exec -T backend npm run db:check:inventory-reconciliation
"${compose[@]}" exec -T backend npm run db:check:money-reconciliation
"${compose[@]}" exec -T backend npm run db:check:transaction-status-reconciliation
"${compose[@]}" exec -T backend npm run db:check:json-configuration-reconciliation

set_record_value "VERIFIED_MIGRATION_COUNT" "$applied_migration_count"
set_record_value "VERIFIED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Migration verification passed: $applied_migration_count applied migrations."
echo "Cloud release verification passed for $SOURCE_REF"
