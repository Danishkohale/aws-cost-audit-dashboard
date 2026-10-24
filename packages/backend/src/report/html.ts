/**
 * HTML report writer — port of cost-optimization.py `write_html`.
 *
 * The layout, CSS and copy are identical to the Python implementation. Like the
 * original, values are interpolated raw (not HTML-escaped); the report is a
 * trusted, self-contained file generated from AWS metadata.
 */
import type { Finding, Payload } from "../types";
import { money, pyNum } from "./format";
import { NO_COST_ROW, NO_FINDINGS_ROW, SAVINGS_LEVERS_HTML } from "../rules/templates";

const PAGE_TITLE = "AWS Cost Optimization Audit";

const STYLE =
	"body{font-family:Inter,Arial;background:#0f172a;color:#f8fafc;padding:24px}" +
	"table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}" +
	"th,td{border:1px solid #334155;padding:8px;text-align:left}" +
	"th{background:#1e293b}" +
	".card{background:#1e293b;padding:16px;border-radius:10px;margin:12px 0}" +
	".green{color:#4ade80}.yellow{color:#facc15}" +
	"h1{background:linear-gradient(135deg,#38bdf8,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent}";

function findingRow(f: Finding): string {
	return (
		`<tr><td>${f.service}</td><td>${f.resource}</td><td>${f.category}</td>` +
		`<td>${f.detail}</td><td>$${pyNum(f.est_monthly_saving_usd)}</td>` +
		`<td>${f.recommendation}</td></tr>`
	);
}

export function buildHtml(payload: Payload): string {
	const rows = payload.findings.map(findingRow).join("") || NO_FINDINGS_ROW;
	const costs =
		Object.entries(payload.live_cost_by_service)
			.map(([k, v]) => `<tr><td>${k}</td><td>$${money(v)}</td></tr>`)
			.join("") || NO_COST_ROW;
	const totalSave = payload.findings.reduce(
		(sum, f) => sum + (Number(f.est_monthly_saving_usd) || 0),
		0,
	);

	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${PAGE_TITLE}</title>
<style>${STYLE}</style>
</head><body><h1>AWS Cost Optimization Audit — Idle & Waste</h1>
<div class="card">Region: <b>${payload.region}</b> · Date: ${payload.date} · Lookback: ${payload.lookback_days}d · <span class="yellow">${payload.cost_note}</span><br>
Estimated potential savings: <span class="green"><b>$${money(totalSave)}/mo</b></span> (estimates, verify in CUR before deleting anything).</div>
<h2>Live Cost by Service (Cost Explorer)</h2><table><tr><th>Service</th><th>Unblended Cost</th></tr>${costs}</table>
<h2>Idle / Waste Findings (${payload.findings.length})</h2>
<table><tr><th>Service</th><th>Resource</th><th>Category</th><th>Detail</th><th>Est. $/mo</th><th>Recommendation</th></tr>${rows}</table>
<div class="card">${SAVINGS_LEVERS_HTML}</div>
</body></html>`;
}
