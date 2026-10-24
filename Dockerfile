# Builds the backend (Bun + Hono) from the pnpm workspace root.
# Build context = repo root, so packages/backend and packages/frontend are both visible.
FROM oven/bun:1.4-alpine
WORKDIR /app

# Install backend production dependencies only (bun:sqlite is native to Bun,
# better-sqlite3 is dev-only for tests and is intentionally absent here).
COPY packages/backend/package.json /app/packages/backend/package.json
WORKDIR /app/packages/backend
RUN bun install --production

# Backend source code
COPY packages/backend/src /app/packages/backend/src

# Static frontend assets — the backend also serves them as a fallback mirror
# of the Cloudflare Pages deployment (harmless duplicate, useful for e2e check).
COPY packages/frontend/public /app/packages/backend/public

ENV NODE_ENV=production
EXPOSE 3000

# serveStatic root "./public" resolves relative to this working directory
WORKDIR /app/packages/backend
CMD ["bun", "src/index.ts"]
