import { useMemo, useState } from "react";
import type { Finding } from "../lib/api";
import { currentCostMo, fmt$, type Metrics } from "../lib/metrics";
import { remediationSteps } from "../lib/remediation";

/** Compact meta detail line — backend-tracked attributes only. */
function metaLine(f: Finding): string {
	const m = (f.meta ?? {}) as Record<string, unknown>;
	const out: string[] = [];
	const push = (k: string, v: unknown, sfx = "") => {
		if (v !== null && v !== undefined && v !== "") out.push(`${k}: ${v}${sfx}`);
	};
	push("Type", m.instance_type ?? m.class ?? m.type);
	push("Size", m.size_gb, " GB");
	push("Objects", m.objects);
	push("State", m.state);
	push("Age", m.age_days, "d");
	push("CPU avg", m.cpu_avg, "%");
	push("CPU max", m.cpu_max, "%");
	push("GETs", m.gets);
	push("PUTs", m.puts);
	return out.join(" · ");
}

/** One finding row — expandable for detail. */
function FindingRow({ f, seq }: { f: Finding; seq: number }) {
	const [open, setOpen] = useState(false);
	const cost = currentCostMo(f);
	const steps = remediationSteps(f);

	return (
		<div className="frow">
			<button className="frow-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className="chk">{open ? "▾" : "▸"}</span>
				<span className="fsvc">{f.service}</span>
				<span className="fres" title={f.resource}>{f.resource}</span>
				<span className="fcost">{cost !== null ? `${fmt$(cost)}/mo` : <em className="dim">n/a</em>}</span>
				<span className="fsave">{fmt$(f.est_monthly_saving_usd)}/mo</span>
			</button>
			{open && (
				<div className="frow-detail">
					<div className="dgrid">
						<div><label>Resource</label><p>{f.resource}</p></div>
						<div><label>Service</label><p>{f.service}</p></div>
						<div><label>Tracking</label><p>{f.category}</p></div>
						<div><label>Current cost</label><p>{cost !== null ? `${fmt$(cost)}/mo` : "not in this window"}</p></div>
						<div><label>Est. savings</label><p className="green">{fmt$(f.est_monthly_saving_usd)}/mo · {fmt$(Number(f.est_monthly_saving_usd) * 12)}/yr</p></div>
					</div>
					{metaLine(f) && <p className="dmeta">{metaLine(f)}</p>}
					<p className="ddetail"><b>Detail</b> {f.detail}</p>
					<label className="dlabel">How to save it</label>
					<ol className="howto">
						{steps.map((s, i) => (
							<li key={i}>{s}</li>
						))}
					</ol>
					<p className="drec"><b>Do this</b> {f.recommendation}</p>
					<p className="fnum dim">Finding #{seq}</p>
				</div>
			)}
		</div>
	);
}

/** Findings — only genuine savings (> $0/mo). */
export function FindingsSection({ m, total }: { m: Metrics; total: number }) {
	const [q, setQ] = useState("");
	const [svc, setSvc] = useState("");
	const services = useMemo(() => [...new Set(m.findings.map((f) => f.service))].sort(), [m.findings]);
	const list = useMemo(() => {
		const needle = q.toLowerCase();
		return m.findings
			.filter((f) => (!svc || f.service === svc) && (!needle || `${f.resource} ${f.detail} ${f.recommendation}`.toLowerCase().includes(needle)))
			.sort((a, b) => Number(b.est_monthly_saving_usd) - Number(a.est_monthly_saving_usd));
	}, [m.findings, svc, q]);
	const filteredTotal = Number(list.reduce((s, f) => s + Number(f.est_monthly_saving_usd || 0), 0).toFixed(2));

	return (
		<section id="findings" className="panel-section">
			<h2>Findings</h2>
			<p className="sec-sub">
				{m.findings.length} measurable savings ({fmt$(total)}/mo total).{" "}
				{m.review.length > 0 && `${m.review.length} additional item${m.review.length === 1 ? "" : "s"} need review but have no measured saving.`}
			</p>

			<div className="tools">
				<select value={svc} onChange={(e) => setSvc(e.target.value)}>
					<option value="">All services</option>
					{services.map((x) => (
						<option key={x} value={x}>{x}</option>
					))}
				</select>
				<input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter findings…" />
				<span className="cnt">{list.length} shown · {fmt$(filteredTotal)}/mo</span>
			</div>

			<div className="fcol head">
				<span /><span>Service</span><span>Resource</span><span className="num">Current/mo</span><span className="num">Est. saving/mo</span>
			</div>

			<div className="flist">
				{list.length > 0 ? (
					list.map((f, i) => <FindingRow key={`${f.resource}-${i}`} f={f} seq={i + 1} />)
				) : (
					<p className="mut">No findings match the filter.</p>
				)}
			</div>
		</section>
	);
}
