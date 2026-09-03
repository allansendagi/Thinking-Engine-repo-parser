# Deploying the Thread backend (Railway)

The API is a single Bun process (`bun run src/api/server.ts`). It stores one SQLite file per
user plus a token registry on the local filesystem.

## The one thing you must not skip: a persistent volume

Railway's container filesystem is **ephemeral**. Without a mounted volume, every redeploy wipes
every user's ideas *and* the token registry — so every previously issued credential starts
returning `401 Invalid credentials`, and the browser extension + Mac app both silently stop
working.

### Attach the volume (one time, ~1 minute)

1. Railway dashboard → your service → **Variables / Volumes** → **New Volume**.
2. Mount path: anything (e.g. `/data`). Railway automatically injects `RAILWAY_VOLUME_MOUNT_PATH`
   with that value.
3. Redeploy.

That's it. The code checks `RAILWAY_VOLUME_MOUNT_PATH` and, when set, stores everything under
`$RAILWAY_VOLUME_MOUNT_PATH/users/` and `$RAILWAY_VOLUME_MOUNT_PATH/registry.db`. No path
variables to configure.

On boot the server logs which mode it's in:

```
[Thread] data dir: /data/users (persistent)
```

or, if you forgot the volume:

```
[Thread] WARNING: no persistent volume detected ... will be WIPED on the next deploy.
```

### Manual override

Set `THREAD_DATA_DIR` and/or `THREAD_REGISTRY_PATH` explicitly to take full control of the paths
(takes precedence over the volume mount).

## Required environment variables

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Extraction + synthesis. Without it, capture succeeds but no ideas are ever produced. |
| `PORT` | Set by Railway automatically. |
| `RAILWAY_VOLUME_MOUNT_PATH` | Set by Railway automatically **once a volume is attached** (see above). |

### Optional

| Var | Purpose |
|---|---|
| `THREAD_ADMIN_EMAILS` | Comma-separated. These accounts can read `GET /v1/events/downloads` (the `/admin` dashboard). Nobody is admin if unset. |
| `THREAD_RATE_LIMIT` | Set to `off` to disable the per-IP limiter on the unauthenticated routes (`/v1/users`, `/v1/auth/start`, `/v1/events/download`). **Never set in production** — the tests and e2e sims set it for themselves. |
| `THREAD_ALLOW_EPHEMERAL` | `1` lets the server boot on non-durable storage instead of failing fast. Only for throwaway environments. |

### Unauthenticated-route protection

`/v1/users`, `/v1/auth/start`, and `/v1/events/download` take no bearer token, so a per-process,
per-IP sliding-window limiter (`src/api/rateLimit.ts`) caps them — it exists to stop a trivial
loop from filling the volume with anon accounts / per-user DB files or poisoning the download
metrics, not as a hard quota. It keys off `x-forwarded-for` (Railway sets it). `/v1/paddle/webhook`
is unauthenticated but HMAC-verified before any DB write. There is intentionally **no CORS
header** — every client is native, server-side, or an extension with explicit host permission;
adding `Access-Control-Allow-Origin` would only open the API to browser-page probing.

## Verifying a deploy

```sh
API=https://<your-service>.up.railway.app
curl -s "$API/v1/health"                       # {"status":"ok"}
U=$(curl -s -XPOST "$API/v1/users")            # {userId, token}
# ...then POST /v1/conversations and GET /v1/thinking-state with that bearer token.
```

After the next redeploy, the same `U` credentials must still work. If they 401, the volume
isn't mounted.
