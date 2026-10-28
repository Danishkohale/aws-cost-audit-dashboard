/**
 * Demo route — generates sample report with no AWS call.
 */
import type { Context, Hono } from "hono";
import { buildDemoPayload } from "../demo/payload";
import { cleanupOld, createJob, finalizeJob, insertFindings, randomId, setCost } from "../db/jobs";
import { waitForSchema } from "../db/libsql";
import { enrichWithLlm } from "../rules/llm";
import { todayIso } from "../report/format";

async function handleDemo(c: Context): Promise<Response> {
	await waitForSchema();
	await cleanupOld();

	const payload = buildDemoPayload(todayIso());
	// Grounded narrative layer (best-effort; no key ⇒ rule text only).
	payload.findings = await enrichWithLlm(payload.findings);
	const jobId = `demo${randomId(4)}`;

	await createJob({ id: jobId, region: payload.region, days: payload.lookback_days });
	await setCost(jobId, payload.live_cost_by_service, payload.cost_note);
	await insertFindings(jobId, payload.findings, 0);
	await finalizeJob(jobId);

	return c.json({ job_id: jobId, status: "done" }, 201);
}

export function registerDemoRoutes(app: Hono): void {
	app.get("/api/demo", (c) => handleDemo(c));
	app.post("/api/demo", (c) => handleDemo(c));
}