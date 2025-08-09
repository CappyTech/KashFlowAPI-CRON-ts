# KashFlowAPI-Cron

TypeScript Node service that fetches KashFlow REST data hourly and upserts into MongoDB via an SSH tunnel.

## Setup

1. Copy .env.example to .env and fill in values:
   - KashFlow credentials (username/password/memorable word)
   - SSH tunnel details (host, username, password, dst/local ports)
   - Mongo DB name and optional mongo user/pass if required by remote

2. Install deps

3. Run in dev:
   - npm run dev

4. Build + start:
   - npm run build
   - npm start

## Notes
- Non-overlapping runs enforced via a mutex.
- Session token is cached and invalidated on 401; requests retry on transient errors.
- Soft delete: documents not seen in a given run are marked with deletedAt.
- State (watermarks) currently stored in collection `app_state`. If you prefer a specific `mongo-connect` package, share the npm package name and we’ll swap it in.
