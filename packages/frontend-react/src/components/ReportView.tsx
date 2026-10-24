import { useMemo, useState } from "react";
import type { Job } from "../lib/api";

const metaBits = (m?: Record<string, unknown>): string => {
	if (!m) return "";
	const out: string[] = [];
	const push = (k: string, v: unknown, sfx = "") => {
		if (v !== null && v !== undefined && v !== "") out.push(`${k} ${v}${sfx}`);
	};
	push("Size", m.size_gb, "GB");
	push("Objects", m.objects);
	push("GET", m.gets);
	push("PUT", m.puts);
	push("CPU", m.cpu_avg, "%");
	push("Type", (m.instance_type as string) ?? (m.class as string) ?? (m.type as string));
	push("Age", m.age_days, "d");
	push("Cost", (m.base_cost_mo as number) ?? (m.est_cost_mo as number), "$/mo");
	return out.join(" · ");
};

export function ReportView({ job, onNew, onDownload }: { job: Job; onNew: () => void; onDownload: (fmt: "json" | "html") => void }) {
	const s = job.summary!;
	const costs = useMemo(
		() => Object.entries(job.payload?.live_cost_by_service ?? {}).sort((a, b) => b[1] - a[1]),
		[job],
	);
	const findings = job.payload?.findings ?? [];
	const [svc, setSvc] = useState("");
	const [q, setQ] = useState("");
	const services = useMemo(() => [...new Set(findings.map((f) => f.service))].sort(), [findings]);
	const list = useMemo(
		() =>
			findings
				.filter((r) => (!svc || r.service === svc) && (!q || `${r.resource} ${r.category} ${r.detail} ${r.recommendation}`.toLowerCase().includes(q.toLowerCase())))
				.sort((a, b) => Number(b.est_monthly_saving_usd || 0) - Number(a.est_monthly_saving_usd || 0)),
		[findings, svc, q],
	);
	const mx = Math.max(...costs.map(([, v]) => v), 0.01);

	return (
		<section className="card">
			<div className="rep-head">
				<h1>Report</h1>
				<button className="btn" onClick={onNew}>← New audit</button>
			</div>
			<p className="metastr">{`${s.region} · ${s.date} · ${s.lookback_days}d lookback · ${s.findings_count} findings`}</p>
			<div className="kpis">
				<div><label>Est. savings</label><b>${Number(s.total_savings).toLocaleString()}/mo</b></div>
				<div><label>Findings</label><b>{s.findings_count}</b></div>
				<div><label>Live cost</label><b>${Number(s.live_cost_total).toLocaleString()}/mo</b></div>
			</div>
			{s.cost_note && <p className="note">{s.cost_note}</p>}

			<h2>Live cost by service</h2>
			<div className="bars">
				{costs.length > 0 ? (
					costs.map(([k, v]) => (
						<div className="brow" key={k}>
							<span>{k}</span>
							<div><i style={{ width: `${((100 * v) / mx).toFixed(1)}%` }} /></div>
							<b>${v.toLocaleString()}</b>
						</div>
					))
				) : (
					<p className="mut">Cost Explorer unavailable.</p>
				)}
			</div>

			<h2>Findings</h2>
			<div className="tools">
				<select value={svc} onChange={(e) => setSvc(e.target.value)}>
					<option value="">All services ({findings.length})</option>
					{services.map((x) => (
						<option key={x} value={x}>
							{x}
						</option>
					))}
				</select>
				<input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter findings…" />
				<span className="cnt">{list.length} shown</span>
			</div>

			<div className="dl">
				<button className="btn" onClick={() => onDownload("json")}>Download JSON</button>
				<button className="btn" onClick={() => onDownload("html")}>Download HTML</button>
			</div>

			<div className="list">
				{list.length > 0 ? (
					list.map((r, i) => (
						<div className="find" key={i}>
							<div className="t">
								<span className="svc">{r.service}</span>
								<span className="save">${r.est_monthly_saving_usd}/mo</span>
							</div>
							<div className="res">{r.resource}</div>
							<div className="cat">{r.category}</div>
							<div className="det">{r.detail}</div>
							{metaBits(r.meta) && <div className="det dim">{metaBits(r.meta)}</div>}
							<div className="rec">→ {r.recommendation}</div>
						</div>
					))
				) : (
					<p className="mut">No findings — well optimized.</p>
				)}
			</div>
		</section>
	);
}
