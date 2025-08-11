# Multi-stage build for KashFlowAPI-CRON-ts
FROM node:20-alpine AS build
WORKDIR /app

# Install build-only dependencies (openssh-client only if truly required; comment out if not needed)
RUN apk add --no-cache openssh-client

# Copy dependency manifests first for better caching
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./

# Install full dependencies (including dev) for build (ignore lifecycle scripts like postinstall for now)
RUN if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi

# Copy sources
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript -> dist (now safe since sources & tsconfig copied and scripts enabled)
RUN npm run build

# Production/runtime image (only production dependencies)
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Copy package.json & lock and install only production deps
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
# Install production deps only, ignoring lifecycle scripts (postinstall runs build which we already did)
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi && npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Optional: keep backfill & scripts if compiled there
COPY --from=build /app/src/scripts ./src/scripts

# Use non-root user for security (node image provides 'node')
USER node

EXPOSE 3000

LABEL org.opencontainers.image.title="KashFlowAPI-CRON" \
      org.opencontainers.image.description="KashFlow REST to MongoDB sync service" \
      org.opencontainers.image.source="https://github.com/CappyTech/KashFlowAPI-CRON-ts" \
      org.opencontainers.image.licenses="MIT"

# Runtime expects required env vars (KASHFLOW_*, MONGO_DB_NAME, and either DIRECT_DB=true or SSH_* set)
CMD ["node", "dist/index.js"]
