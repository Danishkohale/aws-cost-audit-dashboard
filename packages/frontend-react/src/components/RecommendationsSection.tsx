import { effortHours, fmt$, monthlySavings, type Metrics } from "../lib/metrics";

/**
 * Recommendations — grouped by category, with clearly-labeled implementation
 * effort estimates (planning heuristic, mid-level engineer at $/h shown).
 */
export function RecommendationsSection({ m, rate }: { m: Metrics; rate: number }) {
	let assumed = 0;
	for (const cat of m.categories) for (const f of cat.items) if (effortHours(f).assumed) assumed++;

	return (
		<section id="recommendations" className="panel-section">
			<h2>Recommendations</h2>
			<p className="sec-sub">
				Actionable plan — {m.implHours}h total effort (estimate), ≤ {fmt$(m.implCost)} labour at {fmt$(rate)}/h, targeting{" "}
				{fmt$(m.estMonthly)}/mo savings.
			</p>

			<div className="rcats">
				{m.categories.map((cat) => {
					const hours = cat.items.reduce((s, f) => s + effortHours(f).hours, 0);
					return (
						<div className="card rcard" key={cat.category}>
							<div className="rhead">
								<b>{cat.category}</b>
								<span className="green">{fmt$(monthlySavings(cat.items))}/mo</span>
							</div>
							<ul>
								{cat.items.map((f, i) => (
									<li key={i}>
										<b>{f.resource}</b> — {f.recommendation}
										<div className="dim sm">est. saving {fmt$(Number(f.est_monthly_saving_usd))}/mo · ≈{effortHours(f).hours}h</div>
									</li>
								))}
							</ul>
							<p className="rfoot dim">≈{hours}h (est.)</p>
						</div>
					);
				})}
			</div>

			<p className="footnote">
				Effort hours are rough planning estimates, not quotes{assumed > 0 && ";" + ` ${assumed} item${assumed === 1 ? "" : "s"} use a default of 1h`}.
				There is no Cloud spend required for any recommended action (they are delete/rightsize/config tasks).{" "}
				{m.review.length > 0 && `${m.review.length} review item${m.review.length === 1 ? "" : "s"} with no measured saving are listed under Audit Info.`}
			</p>
		</section>
	);
}
