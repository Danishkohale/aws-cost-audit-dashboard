/**
 * On-demand AI route.
 *
 * Nothing is generated during the demo/audit; the narrative is produced only
 * when the browser asks for one finding. `fetch` is stubbed, so these tests
 * never touch the network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Job } from "../src/types";

const req = (path: string, init?: RequestInit) => app.request(path, init);

const postJson = (path: string, body: unknown) =>
	req(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

async function createDemo(): Promise<string> {
	const res = await req("/api/demo", { method: "POST" });
	expect(res.status).toBe(201);
	return ((await res.json()) as { job_id: string }).job_id;
}

async function firstFinding(jobId: string) {
	const job = (await (await req(`/api/audit/${jobId}`)).json()) as Job;
	const f = job.payload?.findings.find((x) => x.rec);
	if (!f) throw new Error("demo payload has no finding with a rec");
	return f;
}

const cleanNarrative = {
	id: "f0",
	business_impact: "Removes the recurring charge for capacity nobody uses.",
	sequencing: "Act during the next maintenance window.",
	owner_hint: "The platform team should confirm ownership.",
	risk_callout: "Confirm nothing still depends on this resource.",
	confidence_note: "Figures come from measured usage.",
};

function stubModel(content: unknown): ReturnType<typeof vi.fn> {
	const fn = vi.fn(async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
	}));
	vi.stubGlobal("fetch", fn);
	return fn;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("POST /api/audit/:jobId/ai", () => {
	it("is disabled when no key is configured", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "");
		const jobId = await createDemo();
		const f = await firstFinding(jobId);
		const res = await postJson(`/api/audit/${jobId}/ai`, {
			service: f.service,
			resource: f.resource,
			category: f.category,
		});
		expect(res.status).toBe(503);
	});

	it("validates the request body", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		const jobId = await createDemo();
		const res = await postJson(`/api/audit/${jobId}/ai`, { service: "EC2" });
		expect(res.status).toBe(400);
	});

	it("returns 404 for an unknown finding", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		const jobId = await createDemo();
		stubModel({ items: [cleanNarrative] });
		const res = await postJson(`/api/audit/${jobId}/ai`, {
			service: "Nope",
			resource: "nope",
			category: "Nope",
		});
		expect(res.status).toBe(404);
	});

	it("generates once, persists it, and serves later calls from cache", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		const jobId = await createDemo();
		const f = await firstFinding(jobId);
		const body = { service: f.service, resource: f.resource, category: f.category };

		const fetchFn = stubModel({ items: [cleanNarrative] });
		const first = await postJson(`/api/audit/${jobId}/ai`, body);
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as {
			narrative: { business_impact: string };
			cached: boolean;
		};
		expect(firstBody.cached).toBe(false);
		expect(firstBody.narrative.business_impact).toContain("recurring charge");

		const job = (await (await req(`/api/audit/${jobId}`)).json()) as Job;
		const saved = job.payload?.findings.find(
			(x) =>
				x.service === body.service && x.resource === body.resource && x.category === body.category,
		);
		expect(saved?.rec?.narrative?.business_impact).toContain("recurring charge");

		const second = await postJson(`/api/audit/${jobId}/ai`, body);
		expect(second.status).toBe(200);
		expect(((await second.json()) as { cached: boolean }).cached).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("rejects a narrative that invents a dollar figure", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		const jobId = await createDemo();
		const f = await firstFinding(jobId);
		stubModel({ items: [{ ...cleanNarrative, business_impact: "Saves $99.99 every month." }] });

		const res = await postJson(`/api/audit/${jobId}/ai`, {
			service: f.service,
			resource: f.resource,
			category: f.category,
		});
		expect(res.status).toBe(502);

		const job = (await (await req(`/api/audit/${jobId}`)).json()) as Job;
		const saved = job.payload?.findings.find(
			(x) => x.service === f.service && x.resource === f.resource,
		);
		expect(saved?.rec?.narrative).toBeUndefined();
	});
});
