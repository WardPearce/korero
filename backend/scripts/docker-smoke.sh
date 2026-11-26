#!/usr/bin/env bash
set -euo pipefail
image=${1:?Pass the built image name}
instance="voice-offline-test-$$"
volume="${instance}-data"
cleanup() {
  docker rm -f "$instance" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
docker run -d --name "$instance" --network none -v "$volume:/data" "$image" >/dev/null
ready() {
  for _ in {1..30}; do
    if docker exec "$instance" curl -kfSs --max-time 1 'https://[::1]:8443/ready' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
ready >/dev/null
test "$(docker exec "$instance" id -u)" = 10001
docker exec "$instance" sh -c '! command -v node && ! command -v bun && ! command -v openssl'
first=$(docker exec "$instance" curl -kfSs 'https://[::1]:8443/api/v1/server/info')
docker restart --time 5 "$instance" >/dev/null
ready >/dev/null
second=$(docker exec "$instance" curl -kfSs 'https://[::1]:8443/api/v1/server/info')
test "$first" = "$second"
test "$(docker logs "$instance" 2>/dev/null | grep -c '^ADMIN SETUP TOKEN$')" = 1
printf '%s\n' "Offline Docker startup, non-root runtime and persistent server identity passed"
