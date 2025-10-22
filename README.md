# KashFlowAPI-Cron

TypeScript service that syncs KashFlow REST data to MongoDB on a schedule, with a small web dashboard for triggering syncs and viewing history/logs.

## Configuration

Core environment variables:

- KashFlow API
  - KASHFLOW_USERNAME, KASHFLOW_PASSWORD, KASHFLOW_MEMORABLE_WORD
  - KASHFLOW_TIMEOUT_MS (optional, default 45000)
- MongoDB
  - DIRECT_DB=true to connect directly (no SSH tunnel), otherwise set SSH_* to tunnel
  - MONGO_HOST, MONGO_PORT, MONGO_DB_NAME, MONGO_USER, MONGO_PASSWORD
- SSH tunnel (when DIRECT_DB=false)
  - SSH_HOST, SSH_PORT, SSH_USERNAME, SSH_PASSWORD
  - SSH_DST_HOST, SSH_DST_PORT, SSH_LOCAL_HOST, SSH_LOCAL_PORT
- Scheduler & flags
  - CRON_SCHEDULE (default: hourly, 0 * * * *)
  - CRON_ENABLED (default: true)
  - RUN_ONCE (default: false)
  - FULL_REFRESH_HOURS (default: 24) — force full traversal periodically
  - INCREMENTAL_SOFT_DELETE (default: true)
  - UPSERT_LOGS (default: false) — verbose per-document upsert logging
- Dashboard server
  - METRICS_ENABLED (default: true)
  - PORT or METRICS_PORT (default: 3000)
  - METRICS_AUTH_USER, METRICS_AUTH_PASS (Basic Auth for all routes)
  - METRICS_ALLOW_REMOTE_TRIGGER (default: false) — allow non-LAN IPs to trigger sync
  - METRICS_TRUST_PROXY (default: false) — trust X-Forwarded-For for client IP

Note: Prometheus /metrics support was removed; the dashboard still exposes operational routes and HTML.

## Dashboard & Routes

All routes require Basic Auth if METRICS_AUTH_* are set.

- / — HTML dashboard (status, history, live logs, trigger buttons)
- /health — unauthenticated health check (“ok”)
- /sync-summary — latest sync summary (HTML or JSON with ?format=json)
- /summaries — recent summaries (HTML or JSON)
- /summary/:id — one summary document (HTML or JSON)
- /logs — tail of logs (HTML or JSON)
- /logs/stream — live logs via Server-Sent Events
- /upserts — recent upsert logs (HTML or JSON; filter with entity, key, since, limit)
- /trigger-sync — trigger a sync (POST preferred; GET allowed)
  - Add ?full=1 to force a one-shot full traversal on the next run

Access control for /trigger-sync:

- Allowed from localhost and LAN IPs by default (10/172.16–31/192.168/169.254, plus IPv6 link-local/ULA)
- Set METRICS_ALLOW_REMOTE_TRIGGER=true to allow any remote IP
- If behind a proxy/load balancer, set METRICS_TRUST_PROXY=true to honor X-Forwarded-For in IP checks and logs

## Sync behavior

- Incremental entities (e.g., quotes, purchases) stop early when they reach the previously synced maximum unless running a full refresh.
- A full refresh (no early stop) runs automatically every FULL_REFRESH_HOURS and can be forced once via /trigger-sync?full=1.
- After a full refresh, if INCREMENTAL_SOFT_DELETE=true, documents not seen in the refresh are soft-deleted.
- Suppliers fetching traverses all pages reliably and enriches list items with detail fetched by code/id to capture fields only present in detail.

## Docker — run app only

Connect to an external MongoDB, either directly or via SSH tunnel.

Example (direct DB mode):

```
docker run -d \
  -e DIRECT_DB=true \
  -e MONGO_HOST=mongodb.internal \
  -e MONGO_PORT=27017 \
  -e MONGO_DB_NAME=kashflow \
  -e KASHFLOW_USERNAME=your_user \
  -e KASHFLOW_PASSWORD=your_pass \
  -e KASHFLOW_MEMORABLE_WORD=word \
  -e METRICS_AUTH_USER=admin \
  -e METRICS_AUTH_PASS=secret \
  -p 3000:3000 \
  kashflow-cron
```

To use an SSH tunnel, set DIRECT_DB=false (default) and pass SSH_HOST/SSH_USERNAME/SSH_PASSWORD, and optional SSH_* ports/hosts.

## docker-compose — app + Mongo

Bring up Mongo and the app (direct DB mode shown):

```
docker compose up -d --build
```

Put secrets in compose.env and reference it from the service:

compose.env:

```
KASHFLOW_USERNAME=your_user
KASHFLOW_PASSWORD=your_pass
KASHFLOW_MEMORABLE_WORD=word
METRICS_AUTH_USER=admin
METRICS_AUTH_PASS=secret
DIRECT_DB=true
MONGO_HOST=mongodb
MONGO_PORT=27017
MONGO_DB_NAME=kashflow
```

docker-compose.yml (snippet):

```
services:
  app:
    env_file:
      - compose.env
```

Logs:

```
docker compose logs -f app
```

Backfill UUIDs (if needed):

```
docker compose exec app node dist/scripts/backfill-uuids.js
```

## Pre-built image (GHCR)

If available, you can pull a published image instead of building locally.

1) Authenticate to GHCR if private:

```
echo <TOKEN> | docker login ghcr.io -u <USER> --password-stdin
```

2) In docker-compose.yml, use image (comment out build):

```
# image: ghcr.io/cappytech/kashflowapi-cron-ts:latest
# build: .
```

3) Pull & start:

```
docker compose pull app
docker compose up -d
```

Tagging suggestions:

- :sha-<gitsha> immutable
- :latest moving pointer
- :vX.Y.Z semver releases
