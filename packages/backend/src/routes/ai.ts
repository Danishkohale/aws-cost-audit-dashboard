/**
 * On-demand AI suggestions.
 *
 *   POST /api/audit/:jobId/ai  → generate the 1–2 line summary for ONE finding
 *
 * Nothing is generated during the audit itself. The browser triggers this when
 * the user opens a finding, so a free-tier model is only paid for (and
 * rate-limited by) what someone actually reads.
 *
 * The rule engine still owns every number: `enrichWithLlm` rejects any
 * summary that cites a `$`/`%` figure absent from the measured facts.
 */
import type { Hono } from "hono";
import { getFindings, updateFindingRec } from "../db/jobs";
import { waitForSchema } from "../db/libsql";
import { errMsg } from "../aws/util";
import { enrichWithLlm, resolveApiKey } from "../rules/llm";

function str(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

export function registerAiRoutes(app: Hono): void {
	app.post("/api/audit/:jobId/ai", async (c) => {
		await waitForSchema();

		const jobId = c.req.param("jobId");
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const service = str(body.service);
		const resource = str(body.resource);
		const category = str(body.category);
		if (!service || !resource || !category) {
			return c.json({ error: "service, resource and category are required." }, 400);
		}
		if (!resolveApiKey()) {
			return c.json({ error: "AI suggestions are not configured on this server." }, 503);
		}

		const findings = await getFindings(jobId);
		const finding = findings.find(
			(f) => f.service === service && f.resource === resource && f.category === category,
		);
		if (!finding) return c.json({ error: "Finding not found for this job." }, 404);
		const rec = finding.rec;
		if (!rec) return c.json({ error: "This finding has no remediation plan." }, 400);

		// Already generated (or generated in another tab) — return the cached text.
		if (rec.narrative) return c.json({ narrative: rec.narrative, cached: true });

		try {
			const [enriched] = await enrichWithLlm([finding]);
			const narrative = enriched.rec?.narrative;
			if (!narrative) {
				return c.json(
					{ error: "The AI response could not be grounded in the measured facts. Try again." },
					502,
				);
			}
			await updateFindingRec(jobId, finding, { ...rec, narrative });
			return c.json({ narrative, cached: false });
		} catch (e) {
			return c.json({ error: `AI suggestion failed: ${errMsg(e)}` }, 502);
		}
	});
}
