import type { Job } from "../lib/api";
import { fmt$, type Metrics } from "../lib/metrics";

/** Audit Info — job metadata + review-only items (no measured saving). */
export function JobInfoSection({ job, m }: { job: Job; m: Metrics }) {
	const s = job.summary!;
	return (
		<section id="jobinfo" className="panel-section">
			<h2>Audit Info</h2>
			<div className="meta card subcard">
				<div className="dgrid">
					<div><label>Job ID</label><p><code>{job.job_id}</code></p></div>
					<div><label>Region</label><p>{s.region}</p></div>
					<div><label>Audit date</label><p>{s.date}</p></div>
					<div><label>Lookback</label><p>{s.lookback_days} days</p></div>
					<div><label>Findings</label><p>{s.findings_count} total · {m.findings.length} actionable</p></div>
					<div><label>Est. totals</label><p>{fmt$(m.estMonthly)}/mo · {fmt$(m.estAnnual)}/yr</p></div>
				</div>
				{s.cost_note && <p className="footnote">{s.cost_note}</p>}
			</div>

			{m.review.length > 0 && (
				<>
					<h3>Review-only items (no measured saving)</h3>
					<ul className="revlist">
						{m.review.map((f, i) => (
							<li key={i}>
								<b>{f.resource}</b> <span className="dim">({f.service} · {f.category})</span> — {f.recommendation}
							</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}
