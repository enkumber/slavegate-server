FROM node:20-alpine AS builder

WORKDIR /app

# Copy shared protocol types
COPY shared/ ./shared/

# Install server dependencies
COPY server/package.json server/tsconfig.json ./server/
WORKDIR /app/server
RUN npm ci

# Build TypeScript
COPY server/src ./src
RUN npm run build

# ─── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/server/node_modules ./node_modules
COPY --from=builder /app/server/package.json ./package.json

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
