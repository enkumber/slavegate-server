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

# Build TypeScript → dist/
RUN npm run build

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Install runtime system dependencies
RUN apk add --no-cache \
    sqlite \
    bash \
    tini

# Copy built artifacts from builder
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Copy migration SQL
COPY src/db/schema.sql ./schema.sql
COPY migrations/ ./migrations/

# Copy startup scripts
COPY scripts/ ./scripts/
RUN chmod +x ./scripts/*.sh

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN mkdir -p /data && chown appuser:appgroup /data
USER appuser

EXPOSE 3000

# tini handles signal forwarding and zombie reaping
ENTRYPOINT ["/sbin/tini", "--", "/app/scripts/entrypoint.sh"]
