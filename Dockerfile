# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /build

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Copy package files first for layer caching
COPY package.json package-lock.json* tsconfig.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY src ./src
COPY shared ./shared

# Build TypeScript → dist/
RUN npm run build

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

ARG VCS_REF=unknown
ENV NODE_ENV=production
ENV BUILD_COMMIT=$VCS_REF

# Install runtime system dependencies
RUN apk add --no-cache \
    postgresql-client \
    bash \
    tini

# Copy built artifacts from builder
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Copy migration SQL — both top-level and src/db/migrations/
COPY src/db/schema.sql ./schema.sql
COPY migrations/ ./migrations/
COPY src/db/migrations/ ./migrations/

# Dashboard static files
COPY dashboard-dist/ ./dashboard-dist/

# APK directory — bundled from repo
COPY apk/ ./apk/

# Copy startup scripts
COPY scripts/ ./scripts/
RUN chmod +x ./scripts/*.sh

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN mkdir -p /data && chown appuser:appgroup /data
RUN chown -R appuser:appgroup ./apk
USER appuser

EXPOSE 21211

# tini handles signal forwarding and zombie reaping
ENTRYPOINT ["/sbin/tini", "--", "/app/scripts/entrypoint.sh"]
