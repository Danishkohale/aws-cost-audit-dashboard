/**
 * Audit routes — simplified for Bun/Node (no subrequest limits).
 *
 *   POST /api/audit            → validate, create job, start background audit, 202
 *   GET  /api/audit/:jobId     → status/view (payload included once done)
 *   GET  /api/audit/:jobId/stream → SSE progress stream
 */
import type { Hono } from "hono";
import { createAws } from "../aws/clients";
import { maskKey } from "../aws/guard";
import { checkIdentity } from "../aws/audit";
import { auditLiveCost } from "../aws/cost-explorer";
import { errMsg } from "../aws/util";
import { runAwsAudit } from "../aws/audit";
import type { AuditOptions } from "../aws/audit";
import {
	appendLog,
	cleanupOld,
	createJob,
	failJob,
	finalizeJob,
	getRow,
	insertFindings,
	jobView,
	markStarted,
	nextSeq,
	setCost,
	setProgress,
	randomId,
} from "../db/jobs";
import { waitForSchema } from "../db/libsql";
import { clearCreds, getCreds, putCreds } from "../creds";
import type { Finding } from "../types";

const REGION_RE = /^[a-z]{2}-[a-z-]+\d$/;

function asString(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

const runningJobs = new Set<string>();

export function registerAuditRoutes(app: Hono): void {
	app.post("/api/audit", async (c) => {
		await waitForSchema();
		await cleanupOld();

		const data = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const accessKey = asString(data.access_key_id) || asString(data.access_key);
		const secretKey = asString(data.secret_access_key) || asString(data.secret_key);
		const sessionToken = asString(data.session_token);
		const region = asString(data.region) || "ap-south-1";
		const parsedDays = Number.parseInt(String(data.days ?? 14), 10);
		const days = Number.isFinite(parsedDays) ? parsedDays : 14;

		if (!accessKey || !secretKey) {
			return c.json({ error: "access_key_id and secret_access_key are required." }, 400);
		}
		if (!REGION_RE.test(region)) {
			return c.json({ error: `Invalid region '${region}'. Example: ap-south-1.` }, 400);
		}
		if (!(days >= 1 && days <= 90)) {
			return c.json({ error: "days must be between 1 and 90." }, 400);
		}

		const jobId = randomId(6);
		await createJob({ id: jobId, region, days });
		await appendLog(jobId, `[auth] Using explicit keys (${maskKey(accessKey)}) in ${region} — in-memory only.`);
		await markStarted(jobId);
		await putCreds(jobId, {
			accessKeyId: accessKey,
			secretAccessKey: secretKey,
			...(sessionToken ? { sessionToken } : {}),
			region,
			days,
		});

		// Start background audit (non-blocking)
		runningJobs.add(jobId);
		runBackgroundAudit(jobId).catch((err) => {
			console.error(`Background audit failed for ${jobId}:`, err);
			failJob(jobId, errMsg(err));
			clearCreds(jobId);
			runningJobs.delete(jobId);
		});

		return c.json({ job_id: jobId, status: "running" }, 202);
	});

	app.get("/api/audit/:jobId", async (c) => {
		const view = await jobView(c.req.param("jobId"));
		if (!view) return c.json({ error: "Unknown job_id." }, 404);
		return c.json(view);
	});

	// SSE endpoint for real-time progress
	app.get("/api/audit/:jobId/stream", async (c) => {
		const jobId = c.req.param("jobId");
		const row = getRow(jobId);
		if (!row) return c.json({ error: "Unknown job_id." }, 404);

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				let lastProgress = -1;
				let lastLogCount = 0;

				const send = (data: object) => {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				};

				// Send initial state
				const initialView = await jobView(jobId);
				if (initialView) send({ type: "state", ...initialView });

				const interval = setInterval(async () => {
					const view = await jobView(jobId);
					if (!view) {
						clearInterval(interval);
						controller.close();
						return;
					}

					// Send progress updates
					if (view.progress !== lastProgress) {
						lastProgress = view.progress;
						send({ type: "progress", progress: view.progress, step: view.step, logs: view.logs });
					}

					// Send new logs
					if (view.logs.length > lastLogCount) {
						lastLogCount = view.logs.length;
						send({ type: "logs", logs: view.logs });
					}

					if (view.status === "done" || view.status === "error") {
						clearInterval(interval);
						send({ type: "complete", ...view });
						controller.close();
					}
				}, 500);

				// Cleanup on disconnect
				c.req.raw.signal.addEventListener("abort", () => clearInterval(interval));
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	});

	// Kept so a stuck run can be surfaced clearly rather than hanging.
	app.post("/api/audit/:jobId/fail", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { error?: string };
		await failJob(c.req.param("jobId"), asString(body.error) || "client aborted");
		await clearCreds(c.req.param("jobId"));
		runningJobs.delete(c.req.param("jobId"));
		return c.json({ ok: true });
	});
}

async function runBackgroundAudit(jobId: string): Promise<void> {
	const row = getRow(jobId);
	if (!row) return;

	const creds = await getCreds(jobId);
	if (!creds) {
		await appendLog(jobId, "[error] Credentials not found in vault");
		await failJob(jobId, "Credentials expired or not found");
		return;
	}

	const aws = createAws(creds, creds.region);
	const findings: Finding[] = [];

	const logFn = (msg: string, progress?: number) => {
		appendLog(jobId, msg);
		if (progress !== undefined) setProgress(jobId, progress, row.step ?? "unknown");
	};

	try {
		await checkIdentity(aws, (m) => appendLog(jobId, m));

		const opts: AuditOptions = {
			days: creds.days,
			log: logFn,
			accessKeyId: creds.accessKeyId,
		};

		const payload = await runAwsAudit(aws, opts);

		// Store cost info
		await setCost(jobId, payload.live_cost_by_service, payload.cost_note);

		// Store findings
		await insertFindings(jobId, payload.findings, await nextSeq(jobId));

		await finalizeJob(jobId);
	} catch (e) {
		await appendLog(jobId, `[error] Audit failed: ${errMsg(e)}`);
		await failJob(jobId, errMsg(e));
	} finally {
		await clearCreds(jobId);
		runningJobs.delete(jobId);
	}
}