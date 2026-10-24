/**
 * Client-side report generation — JSON + standalone HTML downloads.
 */
import type { Job, Finding } from "./api";

const esc = (s: unknown): string =>
	String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export function buildJsonReport(j: Job): string {
	return JSON.stringify(
		{
			date: j.summary!.date,
			region: j.summary!.region,
			lookback_days: j.summary!.lookback_days,
			live_cost_by_service: j.payload!.live_cost_by_service,
			cost_note: j.payload!.cost_note,
			findings: j.payload!.findings,
		},
		null,
		2,
	);
}

export function buildHtmlReport(j: Job): string {
	const s = j.summary!;
	const costs: Array<[string, number]> = Object.entries(j.payload?.live_cost_by_service ?? {}).sort(
		(a, b) => b[1] - a[1],
	);
	const mx = Math.max(...costs.map(([, v]) => v), 0.01);

	const costRows =
		costs.length > 0
			? costs
					.map(
						([k, v]) =>
							`<tr><td>${esc(k)}</td><td><div class="bar"><i style="width:${((100 * v) / mx).toFixed(1)}%"></i></div></td><td class="num">$${v.toLocaleString()}</td></tr>`,
					)
					.join("")
			: `<tr><td colspan="3" class="mut">Cost Explorer unavailable.</td></tr>`;

	const metaBits = (m: Record<string, unknown> | undefined): string => {
		if (!m || typeof m !== "object") return "";
		const out: string[] = [];
		const push = (k: string, v: unknown, sfx = "") => {
			if (v !== null && v !== undefined && v !== "") out.push(`${k} ${v}${sfx}`);
		};
		push("Size", m.size_gb, "GB");
		push("Objects", m.objects);
		push("GET", m.gets);
		push("PUT", m.puts);
		push("CPU", m.cpu_avg, "%");
		push("Type", m.instance_type ?? m.class ?? m.type);
		push("Age", m.age_days, "d");
		push("Cost", m.base_cost_mo ?? m.est_cost_mo, "$/mo");
		return out.length ? `<div class="meta2">${esc(out.join(" · "))}</div>` : "";
	};

	const findingRows: string =
		(j.payload?.findings ?? [])
			.map((f: Finding) => {
				return `<tr><td>${esc(f.service)}</td><td>${esc(f.resource)}</td><td>${esc(f.category)}</td><td>${esc(f.detail)}${metaBits(f.meta)}</td><td class="num">$${Number(f.est_monthly_saving_usd || 0).toLocaleString()}</td><td>${esc(f.recommendation)}</td></tr>`;
			})
			.join("") || `<tr><td colspan="6" class="mut">No findings — well optimized.</td></tr>`;

	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AWS Cost Audit — ${esc(s.region)} ${esc(s.date)}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:2rem}
  h1{font-size:1.5rem;margin-bottom:.2rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem;color:#aaa}
  .meta{display:flex;flex-wrap:wrap;gap:2rem;font-size:.9rem;color:#aaa;margin-bottom:1.5rem}
  table{width:100%;border-collapse:collapse;margin-top:.5rem}
  th,td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid #333;font-size:.85rem;vertical-align:top}
  th{color:#888;font-weight:600}
  .bar{height:.5rem;background:#333;border-radius:.25rem;overflow:hidden}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,#4ade80,#22c55e)}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .mut{color:#888;font-style:italic}
  .meta2{font-size:.75rem;color:#888;margin-top:.25rem}
</style></head><body>
  <h1>AWS Cost Audit Dashboard</h1>
  <div class="meta">
    <span>Region: ${esc(s.region)}</span><span>Date: ${esc(s.date)}</span><span>Lookback: ${s.lookback_days}d</span>
    <span>Findings: ${s.findings_count}</span><span>Est. Savings: $${Number(s.total_savings).toLocaleString()}/mo</span><span>Live Cost: $${Number(s.live_cost_total).toLocaleString()}/mo</span>
  </div>
  <p>${esc(s.cost_note || "—")}</p>
  <h2>Live Cost by Service</h2>
  <table><thead><tr><th>Service</th><th>Share</th><th class="num">Cost/mo</th></tr></thead><tbody>${costRows}</tbody></table>
  <h2>Findings (${s.findings_count})</h2>
  <table><thead><tr><th>Service</th><th>Resource</th><th>Category</th><th>Detail</th><th class="num">Saving/mo</th><th>Recommendation</th></tr></thead><tbody>${findingRows}</tbody></table>
</body></html>`;
}

export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
