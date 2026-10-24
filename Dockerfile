# Builds the backend (Bun + Hono) from the pnpm workspace root.
# The React frontend is deployed separately on Cloudflare Workers, so this
# image contains only the JSON API server.
FROM oven/bun:1.4-alpine
WORKDIR /app

# Install backend production dependencies only (bun:sqlite is native to Bun,
# better-sqlite3 is dev-only for tests and is intentionally absent here).
COPY packages/backend/package.json /app/packages/backend/package.json
WORKDIR /app/packages/backend
RUN bun install --production

# Backend source code
COPY packages/backend/src /app/packages/backend/src

ENV NODE_ENV=production
EXPOSE 3000

WORKDIR /app/packages/backend
CMD ["bun", "src/index.ts"]
