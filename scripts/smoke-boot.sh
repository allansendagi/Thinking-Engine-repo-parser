#!/bin/sh
# Boots the real API server the way Railway does (`bun run src/api/server.ts`) and checks it
# answers. A bad import, a missing runtime API or a syntax the deploy's Bun can't parse only shows
# up when the server actually starts -- which is how a single `statfsSync` import took production
# down (Railway runs an older Bun than CI's `latest`). Exits non-zero with the server's own output.
set -eu
PORT="${PORT:-4390}"
DIR="$(mktemp -d)"
LOG="$DIR/server.log"
cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true; rm -rf "$DIR"; }
trap cleanup EXIT

# THREAD_SERVER_CMD lets CI boot the compiled single-binary engine through the same checks.
CMD="${THREAD_SERVER_CMD:-bun run src/api/server.ts}"
# shellcheck disable=SC2086
PORT="$PORT" THREAD_REGISTRY_PATH="$DIR/registry.db" THREAD_DATA_DIR="$DIR/users" \
  $CMD >"$LOG" 2>&1 &
PID=$!

i=0
until curl -fsS "http://127.0.0.1:$PORT/v1/health" >"$DIR/health.json" 2>/dev/null; do
  i=$((i + 1))
  if ! kill -0 "$PID" 2>/dev/null || [ "$i" -gt 40 ]; then
    echo "::error::server did not come up (bun $(bun --version))"; cat "$LOG"; exit 1
  fi
  sleep 0.5
done
grep -q '"status":"ok"' "$DIR/health.json" || { echo "::error::unexpected health body"; cat "$DIR/health.json"; exit 1; }

# The deep check must answer too (it reports model errors as data, never crashes).
curl -fsS -m 30 "http://127.0.0.1:$PORT/v1/health?deep=1" >"$DIR/deep.json" || { echo "::error::deep health failed"; cat "$LOG"; exit 1; }
grep -q '"disk"' "$DIR/deep.json" || { echo "::error::deep health missing disk"; cat "$DIR/deep.json"; exit 1; }

# A real account round trip: create, authenticate, read.
CREATED="$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/users")"
UID_="$(echo "$CREATED" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p')"
TOKEN="$(echo "$CREATED" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
curl -fsS -H "authorization: Bearer $UID_:$TOKEN" "http://127.0.0.1:$PORT/v1/thinking-state" >/dev/null \
  || { echo "::error::authenticated read failed"; cat "$LOG"; exit 1; }
echo "smoke OK on bun $(bun --version)"
