import { describe, expect, it } from "vitest";
import { buildDemoPayload } from "../src/demo/payload";
import { buildJson } from "../src/report/json";
import { buildHtml } from "../src/report/html";
import { buildDocx } from "../src/report/docx";

const payload = buildDemoPayload("2026-10-18");

const totalSavings = payload.findings.reduce((s, f) => s + f.est_monthly_saving_usd, 0);
const liveCost = Object.values(payload.live_cost_by_service).reduce((s, v) => s + v, 0);

describe("demo payload (ported from app.py demo())", () => {
	it("has 31 findings with the expected totals", () => {
		expect(payload.findings).toHaveLength(31);
		expect(Math.round(totalSavings * 100) / 100).toBeCloseTo(2151.26, 2);
		expect(Math.round(liveCost * 100) / 100).toBeCloseTo(4625.17, 2);
	});
});

describe("buildJson (write_json port)", () => {
	it("is deterministic and 2-space indented", () => {
		const a = buildJson(payload);
		expect(a).toBe(buildJson(payload));
		expect(a).toContain('\n  "date": "2026-10-18"');
		expect(JSON.parse(a).findings).toHaveLength(31);
	});
});

describe("buildHtml (write_html port)", () => {
	it("is deterministic and contains the report chrome", () => {
		const html = buildHtml(payload);
		expect(html).toBe(buildHtml(payload));
		expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
		expect(html).toContain("AWS Cost Optimization Audit — Idle & Waste");
		expect(html).toContain("$2,151.26/mo");
		expect(html).toContain("<td>i-0demo1234abcd</td>");
		expect(html).toContain("Top savings levers:");
		expect(html).toContain("Idle / Waste Findings (31)");
	});

	it("falls back cleanly for an empty payload", () => {
		const empty = { ...payload, findings: [], live_cost_by_service: {} };
		const html = buildHtml(empty);
		expect(html).toContain("No idle/waste found");
		expect(html).toContain("Cost Explorer unavailable");
	});
});

describe("buildDocx (write_docx port)", () => {
	it("produces a valid .docx ZIP buffer", async () => {
		const buf = await buildDocx(payload);
		const bytes = new Uint8Array(buf);
		expect(bytes.length).toBeGreaterThan(1000);
		// DOCX is a ZIP archive → starts with "PK\x03\x04".
		expect(bytes[0]).toBe(0x50);
		expect(bytes[1]).toBe(0x4b);
		expect(bytes[2]).toBe(0x03);
		expect(bytes[3]).toBe(0x04);
	});
});