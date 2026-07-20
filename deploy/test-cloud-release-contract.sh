#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RELEASE_SCRIPT="$PROJECT_DIR/deploy/cloud-release.sh"
ROLLBACK_SCRIPT="$PROJECT_DIR/deploy/cloud-rollback.sh"
VERIFY_SCRIPT="$PROJECT_DIR/deploy/cloud-verify.sh"
SOURCE_REF="0123456789abcdef0123456789abcdef01234567"
OTHER_SOURCE_REF="89abcdef0123456789abcdef0123456789abcdef"

fail() {
  echo "cloud release contract test failed: $*" >&2
  exit 1
}

expect_failure() {
  local expected="$1"
  shift

  local output
  local exit_code
  set +e
  output="$("$@" 2>&1)"
  exit_code=$?
  set -e

  [[ "$exit_code" -ne 0 ]] || fail "command unexpectedly succeeded: $*"
  [[ "$output" == *"$expected"* ]] || fail "expected '$expected', got: $output"
}

temp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

sbom_dir="$temp_dir/sbom"
empty_sbom_dir="$temp_dir/empty-sbom"
fake_bin="$temp_dir/bin"
mkdir -p "$sbom_dir" "$empty_sbom_dir" "$fake_bin"
printf '{}\n' > "$sbom_dir/backend.sbom.spdx.json"
printf '{}\n' > "$sbom_dir/frontend.sbom.spdx.json"
printf 'SOURCE_REF=%s\nRELEASE_TAG=%s\n' "$SOURCE_REF" "$SOURCE_REF" > "$sbom_dir/release-manifest.env"
printf '#!/usr/bin/env bash\nexit 1\n' > "$fake_bin/docker"
chmod +x "$fake_bin/docker"

expect_failure "SOURCE_REF is required" \
  env RELEASE_TAG="$SOURCE_REF" SBOM_DIR="$sbom_dir" bash "$RELEASE_SCRIPT"

expect_failure "RELEASE_TAG and SOURCE_REF must be the same" \
  env RELEASE_TAG="$SOURCE_REF" SOURCE_REF="$OTHER_SOURCE_REF" SBOM_DIR="$sbom_dir" bash "$RELEASE_SCRIPT"

expect_failure "Missing backend SBOM" \
  env RELEASE_TAG="$SOURCE_REF" SOURCE_REF="$SOURCE_REF" SBOM_DIR="$empty_sbom_dir" bash "$RELEASE_SCRIPT"

printf 'SOURCE_REF=%s\nRELEASE_TAG=%s\n' "$OTHER_SOURCE_REF" "$OTHER_SOURCE_REF" > "$sbom_dir/release-manifest.env"
expect_failure "Release manifest does not match" \
  env RELEASE_TAG="$SOURCE_REF" SOURCE_REF="$SOURCE_REF" SBOM_DIR="$sbom_dir" bash "$RELEASE_SCRIPT"

printf 'SOURCE_REF=%s\nRELEASE_TAG=%s\n' "$SOURCE_REF" "$SOURCE_REF" > "$sbom_dir/release-manifest.env"
expect_failure "Missing release image" \
  env PATH="$fake_bin:$PATH" RELEASE_TAG="$SOURCE_REF" SOURCE_REF="$SOURCE_REF" SBOM_DIR="$sbom_dir" bash "$RELEASE_SCRIPT"

release_record="$temp_dir/release.env"
printf 'SOURCE_REF=%s\nRELEASE_TAG=%s\nBACKEND_RELEASE_IMAGE=backend:%s\nWORKER_RELEASE_IMAGE=worker:%s\nWEB_RELEASE_IMAGE=web:%s\nBACKEND_RELEASE_ID=backend-id\nWORKER_RELEASE_ID=worker-id\nWEB_RELEASE_ID=web-id\n' \
  "$OTHER_SOURCE_REF" "$OTHER_SOURCE_REF" "$OTHER_SOURCE_REF" "$OTHER_SOURCE_REF" "$OTHER_SOURCE_REF" > "$release_record"
expect_failure "does not match the requested source commit" \
  env RELEASE_RECORD="$release_record" SOURCE_REF="$SOURCE_REF" bash "$VERIFY_SCRIPT"

printf 'SOURCE_REF=%s\nRELEASE_TAG=%s\nBACKEND_RELEASE_IMAGE=backend:%s\nWORKER_RELEASE_IMAGE=worker:%s\nWEB_RELEASE_IMAGE=web:%s\nBACKEND_RELEASE_ID=backend-id\nWORKER_RELEASE_ID=worker-id\nWEB_RELEASE_ID=web-id\nSTATUS=starting\n' \
  "$SOURCE_REF" "$SOURCE_REF" "$SOURCE_REF" "$SOURCE_REF" "$SOURCE_REF" > "$release_record"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -eu' \
  'if [[ "$1" == "image" && "$2" == "inspect" ]]; then' \
  '  case "$3" in' \
  '    backend:*) printf "backend-id\\n" ;;' \
  '    worker:*) printf "worker-id\\n" ;;' \
  '    web:*) printf "web-id\\n" ;;' \
  '    *) exit 1 ;;' \
  '  esac' \
  '  exit 0' \
  'fi' \
  'if [[ "$1" == "inspect" && "$2" == "worker-container" ]]; then printf "worker-id\\n"; exit 0; fi' \
  'if [[ "$1" == "compose" ]]; then' \
  '  if [[ " $* " == *" ps -q worker "* ]]; then printf "worker-container\\n"; fi' \
  '  if [[ " $* " == *" psql "* ]]; then' \
  '    find "$PROJECT_DIR/server/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l' \
  '  fi' \
  '  exit 0' \
  'fi' \
  'exit 1' > "$fake_bin/docker"
printf '#!/usr/bin/env bash\nprintf "{\\"status\\":\\"ok\\"}\\n"\n' > "$fake_bin/curl"
chmod +x "$fake_bin/docker" "$fake_bin/curl"
env PATH="$fake_bin:$PATH" PROJECT_DIR="$PROJECT_DIR" RELEASE_RECORD="$release_record" SOURCE_REF="$SOURCE_REF" \
  bash "$VERIFY_SCRIPT"
grep -q "^VERIFIED_MIGRATION_COUNT=$(find "$PROJECT_DIR/server/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')$" "$release_record" \
  || fail "successful verification did not record the applied migration count"

rollback_log="$temp_dir/rollback.log"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -eu' \
  'printf "%s\\n" "$*" >> "$ROLLBACK_LOG"' \
  'exit 0' > "$fake_bin/docker"
printf '#!/usr/bin/env bash\nexit 0\n' > "$fake_bin/curl"
chmod +x "$fake_bin/docker" "$fake_bin/curl"

printf 'BACKEND_ROLLBACK_REF=backend:rollback-inline\nWEB_ROLLBACK_REF=web:rollback-inline\nSTATUS=verified\n' > "$release_record"
: > "$rollback_log"
env PATH="$fake_bin:$PATH" ROLLBACK_LOG="$rollback_log" PROJECT_DIR="$PROJECT_DIR" \
  RELEASE_RECORD="$release_record" bash "$ROLLBACK_SCRIPT"
grep -q 'up -d --no-build backend web$' "$rollback_log" \
  || fail "legacy inline-worker rollback did not restore backend/web"
if grep -q 'up -d --no-build .*worker' "$rollback_log"; then
  fail "legacy inline-worker rollback attempted to start an unavailable dedicated worker"
fi

printf 'BACKEND_ROLLBACK_REF=backend:rollback-worker\nWORKER_ROLLBACK_REF=worker:rollback-worker\nWEB_ROLLBACK_REF=web:rollback-worker\nROLLBACK_WORKER_ENABLED=true\nSTATUS=verified\n' > "$release_record"
: > "$rollback_log"
env PATH="$fake_bin:$PATH" ROLLBACK_LOG="$rollback_log" PROJECT_DIR="$PROJECT_DIR" \
  RELEASE_RECORD="$release_record" bash "$ROLLBACK_SCRIPT"
grep -q 'up -d --no-build backend web worker$' "$rollback_log" \
  || fail "dedicated-worker rollback did not restore all three services"

printf 'BACKEND_ROLLBACK_REF=backend:rollback-invalid\nWEB_ROLLBACK_REF=web:rollback-invalid\nROLLBACK_WORKER_ENABLED=invalid\nSTATUS=verified\n' > "$release_record"
expect_failure "Invalid rollback worker mode" \
  env PATH="$fake_bin:$PATH" ROLLBACK_LOG="$rollback_log" PROJECT_DIR="$PROJECT_DIR" \
    RELEASE_RECORD="$release_record" bash "$ROLLBACK_SCRIPT"

echo "cloud release contract tests passed"
