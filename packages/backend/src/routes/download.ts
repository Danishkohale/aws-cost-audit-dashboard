/**
 * Download route — rebuilds report on demand from SQLite.
 */
import type { Hono } from "hono";
import { buildDocx } from "../report/docx";
import { buildHtml } from "../report/html";
import { buildJson } from "../report/json";
import { getRow, jobView } from "../db/jobs";
import type { DownloadFormat } from "../types";

const MIME: Record<DownloadFormat, string> = {
	json: "application/json",
	html: "text/html",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const FORMATS: DownloadFormat[] = ["json", "html", "docx"];

export function registerDownloadRoutes(app: Hono): void {
	app.get("/api/download/:jobId", async (c) => {
		const fmt = (c.req.query("format") || "json").toLowerCase();
		if (!FORMATS.includes(fmt as DownloadFormat)) {
			return c.json({ error: "format must be json, html or docx." }, 400);
		}

		const id = c.req.param("jobId");
		const row = await getRow(id);
		if (!row || row.status !== "done") {
			return c.json({ error: "Report not ready. Wait for status=done." }, 409);
		}

		if (fmt === "docx") {
			const view = await jobView(id);
			const payload = view?.payload;
			if (!payload) return c.json({ error: "DOCX not available." }, 404);

			const body = await buildDocx(payload);
			const region = view?.summary?.region || "aws";
			const date = view?.summary?.date || "report";
			const filename = `cost-optimization-${region}-${date}.docx`;
			return new Response(body, {
				headers: {
					"Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					"Content-Disposition": `attachment; filename="${filename}"`,
				},
			});
		}

		const view = await jobView(id);
		const payload = view?.payload;
		if (!payload) return c.json({ error: `${fmt.toUpperCase()} not available.` }, 404);

		const body = fmt === "json" ? buildJson(payload) : buildHtml(payload);
		const region = view?.summary?.region || "aws";
		const date = view?.summary?.date || "report";
		const filename = `cost-optimization-${region}-${date}.${fmt}`;

		return new Response(body, {
			headers: {
				"Content-Type": `${MIME[fmt as DownloadFormat]}; charset=utf-8`,
				"Content-Disposition": `attachment; filename="${filename}"`,
			},
		});
	});
}