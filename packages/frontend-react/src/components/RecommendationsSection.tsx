import { fmt$, monthlySavings, type Metrics } from "../lib/metrics";

const CONF_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;

/**
 * Recommendations — priority-driven from the recommendation engine's rec
 * blocks (saving × confidence × risk). Falls back to the scan's rule-of-thumb
 * text for findings without an engine plan.
 */
export function RecommendationsSection({ m }: { m: Metrics }) {
	const bands = { P1: 0, P2: 0, P3: 0 };
	for (const cat of m.categories) {
		for (const f of cat.items) {
			const b = f.rec?.priority_band ?? "";
			if (b.startsWith("P1")) bands.P1++;
			else if (b.startsWith("P2")) bands.P2++;
			else bands.P3++;
		}
	}

	return (
		<section id="recommendations" className="panel-section">
			<h2>Recommendations</h2>
			<p className="sec-sub">
				Engine-prioritized plan targeting {fmt$(m.estMonthly)}/mo — {bands.P1} quick-win{bands.P1 === 1 ? "" : "s"} (P1, do first),{" "}
				{bands.P2} scheduled (P2), {bands.P3} when convenient (P3).
			</p>

			<div className="rcats">
				{m.categories.map((cat) => {
					const items = [...cat.items].sort(
						(a, b) => (b.rec?.priority_score ?? 0) - (a.rec?.priority_score ?? 0) || Number(b.est_monthly_saving_usd) - Number(a.est_monthly_saving_usd),
					);
					return (
						<div className="card rcard" key={cat.category}>
							<div className="rhead">
								<b>{cat.category}</b>
								<span className="green">{fmt$(monthlySavings(cat.items))}/mo</span>
							</div>
							<ul>
								{items.map((f, i) => (
									<li key={i}>
										<b>{f.resource}</b> — {f.rec?.change ?? f.recommendation}
										<div className="dim sm">
											est. save {fmt$(Number(f.est_monthly_saving_usd))}/mo
											{f.rec?.priority_band && <> · {f.rec.priority_band}</>}
											{f.rec && <> · confidence {CONF_LABEL[f.rec.confidence]}</>}
											{f.rec?.risks && f.rec.risks.length > 0 && <> · risk: {f.rec.risks[0]}</>}
										</div>
									</li>
								))}
							</ul>
						</div>
					);
				})}
			</div>

			<p className="footnote">
				Priority = est. saving × confidence × risk (engine-computed, P1 first). Every number is an estimate traced in each
				finding's "Calculation" line — Data gaps state what is missing rather than guessing. There is no new Cloud spend
				required for any recommended action (delete/rightsize/config tasks).{" "}
				{m.review.length > 0 && `${m.review.length} review item${m.review.length === 1 ? "" : "s"} with no measured saving are listed under Audit Info.`}
			</p>
		</section>
	);
}
