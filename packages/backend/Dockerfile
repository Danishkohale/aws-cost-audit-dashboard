# Multi-stage build for Bun + Hono AWS Cost Audit Dashboard
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Install Python for native modules (if needed)
RUN apk add --no-cache python3 make g++

# Production dependencies only (no better-sqlite3 - uses bun:sqlite)
FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Frontend assets stage
FROM base AS frontend
WORKDIR /app
COPY ../frontend/public ./public

# Production runner
FROM base AS runner
ENV NODE_ENV=production
ENV DB_DIR=/data

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY src ./src

# Copy frontend assets
COPY --from=frontend /app/public ./public

# Create data directory
RUN mkdir -p /data

EXPOSE 3000

# Start the server
CMD ["bun", "src/index.ts"]