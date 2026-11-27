#!/bin/sh
set -eu
CF_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -x "$CF_ROOT/.local/node/bin/node" ]; then
  PATH="$CF_ROOT/.local/node/bin:$PATH"
  export PATH
fi
cd "$CF_ROOT"
if [ "$#" -eq 0 ]; then
  exec npm run demo
fi
exec "$@"
