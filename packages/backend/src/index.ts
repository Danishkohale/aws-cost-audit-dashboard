/**
 * AWS Cost Audit Dashboard — Bun + Hono server.
 *
 * Routes:
 *   GET  /api/health              → JSON
 *   POST /api/demo                → sample report, no AWS call
 *   POST /api/audit               → start audit, returns job_id
 *   GET  /api/audit/:jobId        → job status/view
 *   GET  /api/audit/:jobId/stream → SSE progress stream
 *   GET  /api/download/:jobId     → json | html | docx report
 *   everything else               → static assets (SPA)
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerAuditRoutes } from "./routes/audit";
import { registerDemoRoutes } from "./routes/demo";
import { registerDownloadRoutes } from "./routes/download";

const app = new Hono();

// CORS configuration for Cloudflare Pages frontend
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
app.use("/*", cors({
  origin: FRONTEND_ORIGIN === "*" ? "*" : [FRONTEND_ORIGIN],
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 86400,
}));

app.get("/api/health", (c) =>
	c.json({
		ok: true,
		service: "aws-cost-audit-dashboard",
		platform: "bun",
	}),
);

registerAuditRoutes(app);
registerDemoRoutes(app);
registerDownloadRoutes(app);

// /api/* must always return JSON, never the HTML fallback
app.all("/api/*", (c) => c.json({ error: "Not found. Is the backend up to date?" }, 404));

// Serve static assets from ./public - dynamic import for Bun compatibility
const isTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";

if (!isTest) {
	// Dynamic import to avoid loading hono/bun in Node.js test environment
	const { serveStatic } = await import("hono/bun");
	app.get("*", serveStatic({ root: "./public" }));
	app.get("*", serveStatic({ path: "./public/analyze.html" })); // SPA fallback
} else {
	// In tests, just 404 for non-API routes
	app.get("*", (c) => c.json({ error: "Not found" }, 404));
}

export { app };
export default app;