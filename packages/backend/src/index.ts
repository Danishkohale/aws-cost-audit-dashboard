/**
 * AWS Cost Audit Dashboard — Bun + Hono API server.
 * Frontend (React + Vite) is deployed separately on Cloudflare Workers;
 * this backend serves only the JSON API.
 *
 * Routes:
 *   GET  /api/health              → JSON
 *   POST /api/demo                → sample report, no AWS call
 *   POST /api/audit               → start audit, returns job_id
 *   GET  /api/audit/:jobId        → job status/view
 *   GET  /api/audit/:jobId/stream → SSE progress stream
 *   GET  /api/download/:jobId     → json | html | docx report
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerAiRoutes } from "./routes/ai";
import { registerAuditRoutes } from "./routes/audit";
import { registerDemoRoutes } from "./routes/demo";
import { registerDownloadRoutes } from "./routes/download";

const app = new Hono();

// CORS — the Cloudflare Workers frontend origin (or * by default)
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
registerAiRoutes(app);
registerDemoRoutes(app);
registerDownloadRoutes(app);

// /api/* must always return JSON, never the HTML fallback
app.all("/api/*", (c) => c.json({ error: "Not found. Is the backend up to date?" }, 404));

// Everything else → 404 (frontend lives on Cloudflare)
app.all("*", (c) => c.json({ error: "Not found" }, 404));

export { app };
export default app;
