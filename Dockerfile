# Multi-stage build for Bun + Hono AWS Cost Audit Dashboard
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Install Python for native modules (only needed for better-sqlite3 in tests)
RUN apk add --no-cache python3 make g++

# Install ALL dependencies (including dev deps for tests)
FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Build stage - run tests
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run test

# Production stage - only production deps, no better-sqlite3
FROM base AS runner
ENV NODE_ENV=production
ENV DB_DIR=/data

# Install only production dependencies (no better-sqlite3 needed - using bun:sqlite)
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Copy application code
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public

# Create data directory
RUN mkdir -p /data

EXPOSE 3000

# Start the server
CMD ["bun", "src/index.ts"]