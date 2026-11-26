#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
case ${1:-} in
  dev|build)
    if [[ $(uname -sm) == 'Linux x86_64' ]]; then
      bash scripts/prepare-media.sh --if-needed
    fi
    if [[ $(uname -s) == Linux && $1 == dev ]]; then
      bun run build:browser-media
    fi
    ;;
esac

exec ./node_modules/.bin/tauri "$@"
