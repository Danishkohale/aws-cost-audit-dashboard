import type { Job } from "../lib/api";
import { fmt$, type Metrics } from "../lib/metrics";

/**
 * Overview — headline numbers + honest actual-vs-estimated panel.
 * "Actual" is deliberately NOT fabricated: the backend does not track
 * realized savings yet, so it shows "Not yet measured".
 */
export function OverviewSection({ job, m }: { job: Job; m: Metrics }) {
	const s = job.summary!;
	return (
		<section id="overview" className="panel-section">
			<h2>Overview</h2>
			<p className="sec-sub">
				{s.region} · audited {s.date} · {s.lookback_days}-day lookback · {s.findings_count} findings ({m.findings.length} actionable)
				{s.cost_note ? ` · ${s.cost_note}` : ""}
			</p>

			<div className="kpis">
				<div className="kpi">
					<label>Est. monthly savings</label>
					<b className="green">{fmt$(m.estMonthly)}</b>
					<span>from {m.findings.length} findings</span>
				</div>
				<div className="kpi">
					<label>Est. annual savings</label>
					<b>{fmt$(m.estAnnual)}</b>
					<span>12 × monthly est.</span>
				</div>
				<div className="kpi">
					<label>Live cost (est.)</label>
					<b>{fmt$(Number(s.live_cost_total))}/mo</b>
					<span>Cost Explorer window</span>
				</div>
			</div>

			<div className="card subcard">
				<h3>Actual vs. estimated savings</h3>
				<table className="tbl">
					<thead>
						<tr>
							<th></th>
							<th className="num">Monthly</th>
							<th className="num">Annual</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>Estimated (this audit)</td>
							<td className="num">{fmt$(m.estMonthly)}</td>
							<td className="num">{fmt$(m.estAnnual)}</td>
						</tr>
						<tr>
							<td>Actual</td>
							<td className="num dim">—</td>
							<td className="num dim">Not yet measured</td>
						</tr>
					</tbody>
				</table>
				<p className="footnote">
					Actual savings are only known after the recommended changes are applied and the next audit is run — never
					assumed here. Re-run the audit after remediation to fill the "Actual" row with measured data.
				</p>
			</div>
		</section>
	);
}
