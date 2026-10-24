import { fmt$, type Metrics } from "../lib/metrics";

/** Service-wise savings chart — potential monthly savings per AWS service. */
export function SavingsByService({ m, total }: { m: Metrics; total: number }) {
	return (
		<section id="savings" className="panel-section">
			<h2>Savings by Service</h2>
			<p className="sec-sub">Potential monthly savings summed from actionable findings ({m.findings.length} items).</p>
			{m.byService.length > 0 ? (
				<div className="svc-chart">
					{m.byService.map((s) => (
						<div className="srow" key={s.service}>
							<span className="ssvc">{s.service}</span>
							<div className="sbar">
								<i style={{ width: `${Math.max(((100 * s.savings) / total), 0.4).toFixed(1)}%` }} />
							</div>
							<span className="scnt">{s.count} finding{s.count === 1 ? "" : "s"}</span>
							<b className="sgreen">{fmt$(s.savings)}/mo</b>
						</div>
					))}
				</div>
			) : (
				<p className="mut">No measurable savings found — well optimized.</p>
			)}
		</section>
	);
}
