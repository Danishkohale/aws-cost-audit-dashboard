import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import type { Job } from "../src/types";
import { createTestCredsNamespace, createTestDb } from "./d1";

/** Hono lets us hand each request its own bindings. */
let env: { DB: ReturnType<typeof createTestDb>; CREDS: ReturnType<typeof createTestCredsNamespace> };

beforeEach(() => {
	env = {
		DB: createTestDb(),
		CREDS: createTestCredsNamespace(),
	};
});

const req = (path: string, init?: RequestInit) => app.request(path, init, env);

const postJson = (path: string, body: unknown) =>
	req(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

const CREDS_BODY = {
	access_key_id: "AKIAIOSFODNN7EXAMPLE",
	secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	region: "ap-south-1",
	days: 14,
};

async function createDemo(): Promise<string> {
	const res = await req("/api/demo", { method: "POST" });
	expect(res.status).toBe(201);
	const body = (await res.json()) as { job_id: string; status: string };
	expect(body.status).toBe("done");
	return body.job_id;
}

describe("demo API (end-to-end through SQLite, no AWS)", () => {
	it("creates a completed demo job that is then readable", async () => {
		const jobId = await createDemo();
		const res = await req(`/api/audit/${jobId}`);
		expect(res.status).toBe(200);
		const job = (await res.json()) as Job;
		expect(job.status).toBe("done");
		expect(job.progress).toBe(100);
		expect(job.summary?.findings_count).toBe(31);
		expect(job.summary?.total_savings).toBeCloseTo(2151.26, 2);
		expect(job.summary?.docx_available).toBe(true);
		expect(job.payload?.findings).toHaveLength(31);
	});

	it("round-trips every finding through SQLite without loss", async () => {
		const jobId = await createDemo();
		const job = (await (await req(`/api/audit/${jobId}`)).json()) as Job;
		const withMeta = job.payload?.findings.filter((f) => f.meta) ?? [];
		expect(withMeta.length).toBeGreaterThan(0);
		expect(withMeta.every((f) => typeof f.meta === "object" && f.meta !== null)).toBe(true);
	});

	it("downloads json and html with the right content types", async () => {
		const jobId = await createDemo();
		const cases = [
			["json", "application/json"],
			["html", "text/html"],
		] as const;
		for (const [fmt, mime] of cases) {
			const res = await req(`/api/download/${jobId}?format=${fmt}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain(mime);
			expect(res.headers.get("content-disposition")).toContain(`.${fmt}"`);
		}
	});

	it("serves the json download from the same findings as the view", async () => {
		const jobId = await createDemo();
		const job = (await (await req(`/api/audit/${jobId}`)).json()) as Job;
		const report = (await (await req(`/api/download/${jobId}?format=json`)).json()) as {
			findings: unknown[];
			region: string;
		};
		expect(report.findings).toHaveLength(job.summary?.findings_count ?? -1);
		expect(report.region).toBe(job.summary?.region);
	});

	it("downloads a structured DOCX report with per-service tables", async () => {
		const jobId = await createDemo();
		const res = await req(`/api/download/${jobId}?format=docx`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("wordprocessingml.document");
		expect(res.headers.get("content-disposition")).toContain('.docx"');
		// DOCX is a ZIP container — the PK header must be present.
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes.length).toBeGreaterThan(1000);
		expect(bytes[0]).toBe(0x50); // P
		expect(bytes[1]).toBe(0x4b); // K
	});
});

describe("audit API", () => {
	it("rejects bad input with JSON errors", async () => {
		const noKeys = await postJson("/api/audit", { region: "ap-south-1" });
		expect(noKeys.status).toBe(400);

		const badRegion = await postJson("/api/audit", { ...CREDS_BODY, region: "not a region" });
		expect(badRegion.status).toBe(400);

		const badDays = await postJson("/api/audit", { ...CREDS_BODY, days: 0 });
		expect(badDays.status).toBe(400);

		for (const res of [noKeys, badRegion, badDays]) {
			expect(res.headers.get("content-type")).toContain("application/json");
		}
	});

	it("creates a running job and returns job_id", async () => {
		const res = await postJson("/api/audit", CREDS_BODY);
		expect(res.status).toBe(202);
		const body = (await res.json()) as { job_id: string; status: string };
		expect(body.status).toBe("running");
		expect(body.job_id).toMatch(/^[0-9a-f]{12}$/);

		const job = (await (await req(`/api/audit/${body.job_id}`)).json()) as Job;
		expect(job.status).toBe("running");
		expect(job.progress).toBe(0);
	});

	it("never persists the secret key — only the masked key reaches the log", async () => {
		const res = await postJson("/api/audit", CREDS_BODY);
		const { job_id } = (await res.json()) as { job_id: string };
		const job = (await (await req(`/api/audit/${job_id}`)).json()) as Job;
		const all = JSON.stringify(job);
		expect(all).toContain("AKIA****MPLE");
		expect(all).not.toContain(CREDS_BODY.secret_access_key);
		expect(all).not.toContain("wJalrXUtnFEMI");
	});

	it("404s unknown jobs", async () => {
		const res = await req("/api/audit/does-not-exist");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
	});
});

describe("error handling", () => {
	it("returns JSON errors (never HTML) for bad requests", async () => {
		const badFormat = await req("/api/download/anything?format=xml");
		expect(badFormat.status).toBe(400);
		expect(badFormat.headers.get("content-type")).toContain("application/json");

		const unknownApi = await req("/api/nope");
		expect(unknownApi.status).toBe(404);
		expect(unknownApi.headers.get("content-type")).toContain("application/json");
	});

	it("health endpoint reports ok", async () => {
		const res = await req("/api/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; platform: string };
		expect(body.ok).toBe(true);
		expect(body.platform).toBe("bun");
	});
});