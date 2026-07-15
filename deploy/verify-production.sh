#!/bin/sh
set -eu

base_url="${BASE_URL:-http://127.0.0.1:8080}"
attempts="${HEALTHCHECK_ATTEMPTS:-30}"
delay_seconds="${HEALTHCHECK_DELAY_SECONDS:-2}"
health_url="${base_url%/}/api/health"

case "$attempts" in
  ''|*[!0-9]*) echo "HEALTHCHECK_ATTEMPTS must be a positive integer" >&2; exit 2 ;;
esac

if [ "$attempts" -lt 1 ]; then
  echo "HEALTHCHECK_ATTEMPTS must be at least 1" >&2
  exit 2
fi

response_file="$(mktemp)"
headers_file="$(mktemp)"
cleanup() {
  rm -f "$response_file" "$headers_file"
}
trap cleanup EXIT

last_error="service did not become healthy"
i=1
while [ "$i" -le "$attempts" ]; do
  if curl -fsS --max-time 10 "$health_url" >"$response_file" \
    && grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$response_file"; then
    break
  fi
  last_error="health check failed on attempt $i/$attempts: $health_url"
  if [ "$i" -lt "$attempts" ]; then
    sleep "$delay_seconds"
  fi
  i=$((i + 1))
done

if [ "$i" -gt "$attempts" ]; then
  echo "$last_error" >&2
  exit 1
fi

if printf '%s' "$base_url" | grep -q '^https://'; then
  curl -fsSI --max-time 10 "$base_url" >"$headers_file"
  for header in strict-transport-security content-security-policy x-content-type-options x-frame-options referrer-policy permissions-policy; do
    if ! grep -Eiq "^$header:" "$headers_file"; then
      echo "Required security header missing: $header" >&2
      exit 1
    fi
  done
fi

echo "Production verification passed: $health_url"
