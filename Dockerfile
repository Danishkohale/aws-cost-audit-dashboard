# Multi-stage build for Bun + Hono AWS Cost Audit Dashboard
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Build stage
FROM base AS builder
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Production stage
FROM base AS runner
ENV NODE_ENV=production
ENV DB_DIR=/data

# Copy built application and dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./

# Create data directory
RUN mkdir -p /data

EXPOSE 3000

# Start the server
CMD ["bun", "src/index.ts"]