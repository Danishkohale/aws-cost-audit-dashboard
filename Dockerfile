# Multi-stage build for Bun + Hono AWS Cost Audit Dashboard
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Install Python for native modules (if needed)
RUN apk add --no-cache python3 make g++

# Production dependencies only (no better-sqlite3 - uses bun:sqlite)
FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Test stage - use Node.js image which has better-sqlite3 prebuilt for Node 20+
FROM node:20-alpine AS test
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm test

# Production runner
FROM base AS runner
ENV NODE_ENV=production
ENV DB_DIR=/data

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY --from=test /app/src ./src
COPY --from=test /app/public ./public

# Create data directory
RUN mkdir -p /data

EXPOSE 3000

# Start the server
CMD ["bun", "src/index.ts"]