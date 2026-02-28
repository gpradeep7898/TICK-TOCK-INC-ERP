# ─── Stage 1: install production dependencies ─────────────────────────────────
FROM node:18-alpine AS deps

WORKDIR /build
COPY api/package*.json ./
RUN npm ci --omit=dev

# ─── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:18-alpine

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Mirror local project layout inside /app so all relative paths resolve correctly:
#   /app/api/src/server.js  → WEB_DIR = /app/web  (path.join(__dirname,'../..','web'))
#   /app/api/src/routes/    → backups = /app/backups (path.join(__dirname,'../../..','backups'))
WORKDIR /app

# Production node_modules
COPY --from=deps --chown=appuser:appgroup /build/node_modules ./api/node_modules

# API source
COPY --chown=appuser:appgroup api/src      ./api/src
COPY --chown=appuser:appgroup api/scripts  ./api/scripts
COPY --chown=appuser:appgroup api/package.json ./api/

# Web assets (served as static files by Express)
COPY --chown=appuser:appgroup web ./web

# DB migrations (used by scripts/setup.sh and docker-compose initdb.d)
COPY --chown=appuser:appgroup db/migrations ./db/migrations

# Backups directory (mounted as a named volume in production)
RUN mkdir -p /app/backups && chown appuser:appgroup /app/backups

USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:3001/health || exit 1

WORKDIR /app/api
CMD ["node", "src/server.js"]
