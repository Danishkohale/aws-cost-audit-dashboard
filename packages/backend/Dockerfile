# Multi-stage build for Bun + Hono AWS Cost Audit Dashboard
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Install Python for native modules (if needed)
RUN apk add --no-cache python3 make g++

# Production dependencies only (no better-sqlite3 - uses bun:sqlite)
FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Test stage - use Bun directly (simpler, avoids pnpm workspace complexity in Docker)
# Tests run locally in CI; we skip them in Docker build for faster deploys
# FROM node:20-alpine AS test
# WORKDIR /app
# RUN apk add --no-cache python3 make g++
# COPY package.json package-lock.json* ./
# RUN npm ci
# COPY src ./src
# COPY test ./test
# COPY vitest.config.ts ./
# COPY tsconfig.json ./
# RUN npm test

# Production runner
FROM base AS runner
ENV NODE_ENV=production
ENV DB_DIR=/data

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY src ./src
COPY public ./public

# Create data directory
RUN mkdir -p /data

EXPOSE 3000

# Start the server
CMD ["bun", "src/index.ts"]