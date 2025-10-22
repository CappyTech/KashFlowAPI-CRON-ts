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

# Prune dev dependencies so we can reuse node_modules in the runtime image without running npm there
RUN npm prune --omit=dev && npm cache clean --force

# Production/runtime image (only production dependencies)
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Reuse pruned production node_modules from build stage to avoid running npm under QEMU for arm64
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

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
