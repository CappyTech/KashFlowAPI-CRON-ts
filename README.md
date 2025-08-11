# KashFlowAPI-Cron

TypeScript Node service that fetches KashFlow REST data hourly and upserts into MongoDB via an SSH tunnel.

### docker-compose

Run the app only (expects an external MongoDB reachable directly or via SSH tunnel):

```
  -e MONGO_DB_NAME=kashflow \
```

Set `DIRECT_DB=true` if you want to connect straight to Mongo (and omit SSH_* vars). Leave `DIRECT_DB=false` (default) with SSH variables to open a tunnel.

Example env file `compose.env` (direct DB mode):
```
DIRECT_DB=true
MONGO_HOST=mongodb.internal
MONGO_PORT=27017
MONGO_DB_NAME=kashflow
KASHFLOW_USERNAME=your_user
KASHFLOW_PASSWORD=your_pass
KASHFLOW_MEMORABLE_WORD=word
METRICS_AUTH_USER=admin
METRICS_AUTH_PASS=secret
```

Add to compose service:
```
    env_file:
      - compose.env
```

Recreate:
```
  -e SSH_HOST=ssh.example.com \
```

UUID backfill:
```
  -e SSH_USERNAME=sshuser \
```

Logs:
```
  -e SSH_PASSWORD=sshpass \
```
  -e METRICS_AUTH_USER=admin \
  -e METRICS_AUTH_PASS=secret \
  -p 3000:3000 \
  kashflow-cron
```

If connecting directly to Mongo (no SSH tunnel):

```
docker run -d \
  -e DIRECT_DB=true \
  -e MONGO_HOST=mongodb \
  -e MONGO_PORT=27017 \
  -e MONGO_DB_NAME=kashflow \
  -e KASHFLOW_USERNAME=... \
  -e KASHFLOW_PASSWORD=... \
  -e KASHFLOW_MEMORABLE_WORD=... \
  -e METRICS_AUTH_USER=admin \
  -e METRICS_AUTH_PASS=secret \
  -p 3000:3000 \
  kashflow-cron
```

Backfill UUIDs (if needed):

```
docker run --rm \
  -e (same vars) \
  kashflow-cron node dist/scripts/backfill-uuids.js
```

### docker-compose

Spin up Mongo + the app (direct DB mode, no SSH tunnel):

```
docker compose up -d --build
```

Override required KashFlow secrets via an env file:

1. Create `compose.env`:
```
KASHFLOW_USERNAME=your_user
KASHFLOW_PASSWORD=your_pass
KASHFLOW_MEMORABLE_WORD=word
METRICS_AUTH_USER=admin
METRICS_AUTH_PASS=secret
```
2. Update service in docker-compose.yml (app) to include:
```
    env_file:
      - compose.env
```
3. Recreate:
```
docker compose up -d --build
```

To run the UUID backfill in the running container:
```
docker compose exec app node dist/scripts/backfill-uuids.js
```

To view logs:
```
docker compose logs -f app
```
