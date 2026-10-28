import { useMemo, useState } from "react";
import type { Finding, RecDetail, RecNarrative } from "../lib/api";
import { generateAiSuggestion, narrativeText } from "../lib/api";
import { currentCostMo, fmt$, type Metrics } from "../lib/metrics";

const CONF_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;
const CONF_CLASS = { high: "conf-h", medium: "conf-m", low: "conf-l" } as const;

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

/** The engine's structured, evidence-based remediation plan. */
function EnginePlan({
	rec,
	narrative,
	busy,
	err,
	onRetry,
	hasJob,
}: {
	rec: RecDetail;
	narrative?: RecNarrative;
	busy: boolean;
	err: string | null;
	onRetry: () => void;
	hasJob: boolean;
}) {
	return (
		<div className="engine">
			<div className="dgrid">
				<div><label>Current config</label><p>{rec.current_config}</p></div>
				<div><label>Detected issue</label><p>{rec.issue}</p></div>
				<div><label>Confidence</label>
					<p><span className={`conf ${CONF_CLASS[rec.confidence]}`}>{CONF_LABEL[rec.confidence]}</span> {rec.confidence_basis}</p>
				</div>
				<div><label>Priority</label><p>{rec.priority_band} · score {rec.priority_score}</p></div>
			</div>

			<label className="dlabel">Evidence (measured)</label>
			<ul className="evidence">
				{rec.evidence.map((e, i) => <li key={i}>{e}</li>)}
			</ul>

			{rec.options.length > 1 && (
				<>
					<label className="dlabel">Options compared</label>
					<div className="opts">
						{rec.options.map((o, i) => (
							<div key={i} className={`opt ${i === rec.selected ? "best" : ""}`}>
								<span className="optn">{i === rec.selected ? "✓" : String.fromCharCode(65 + i)}</span>
								<div>
									<b>{o.title}</b>
									<p>{o.change}</p>
									<p className="dim">
										{o.saving_mo !== null && <>est. save {fmt$(o.saving_mo)}/mo · </>}
										{o.trade_off}
									</p>
								</div>
							</div>
						))}
					</div>
				</>
			)}

			<p className="dwhy"><b>Why this is best</b> {rec.why_selected}</p>
			<p className="drec"><b>Do this</b> {rec.change}</p>
			<div className="ai-note">
				<span className="ai-badge">AI suggestions</span>
				{busy && <span>Checking the rule output…</span>}
				{!busy && narrative && <span>LLM ({narrative.model}) — verified against the rule engine</span>}
				{!busy && !narrative && err && (
					<>
						<span className="errmsg">AI unavailable: {err}</span>
						<button className="btn ai-retry" onClick={onRetry}>Retry</button>
					</>
				)}
				{!busy && !narrative && !err && !hasJob && <span>Needs an audit job.</span>}
			</div>
			{narrative && <p className="ai-summary">{narrativeText(narrative)}</p>}
			<div className="costline">
				<span><b>Cost</b> {rec.current_cost_mo !== null ? `${fmt$(rec.current_cost_mo)}/mo` : "not in window"} → {rec.projected_cost_mo !== null ? `${fmt$(rec.projected_cost_mo)}/mo after the change` : "projected not computable"}</span>
				{rec.saving_mo !== null && <span className="green"><b>Net saving</b> {fmt$(rec.saving_mo)}/mo · {fmt$(rec.saving_an ?? rec.saving_mo * 12)}/yr</span>}
			</div>
			<p className="dcalc"><b>Calculation</b> {rec.calc_method}</p>
			{rec.estimate_note && <p className="dcalc dim">{rec.estimate_note}</p>}

			<label className="dlabel">Risks</label>
			<ul className="risks">
				{rec.risks.map((r, i) => <li key={i}>{r}</li>)}
			</ul>

			{rec.data_gaps.length > 0 && (
				<>
					<label className="dlabel dim2">Data gaps — what is missing, not guessed</label>
					<ul className="risks gap">
						{rec.data_gaps.map((r, i) => <li key={i}>{r}</li>)}
					</ul>
				</>
			)}
			<p className="dmeta">{rec.tracking}</p>
		</div>
	);
}

/** One finding row — expandable for detail; the AI suggestion loads on expand. */
function FindingRow({ f, seq, jobId }: { f: Finding; seq: number; jobId: string | null }) {
	const [open, setOpen] = useState(false);
	const [narrative, setNarrative] = useState<RecNarrative | undefined>(f.rec?.narrative);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const cost = currentCostMo(f);

	async function generate() {
		if (!jobId || busy || !f.rec) return;
		setBusy(true);
		setErr(null);
		try {
			const r = await generateAiSuggestion(jobId, f);
			setNarrative(r.narrative);
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	function toggle() {
		const next = !open;
		setOpen(next);
		// Generated on first expand only — never during the scan itself.
		if (next && f.rec && !narrative && !busy) void generate();
	}

	return (
		<div className="frow">
			<button className="frow-head" onClick={toggle} aria-expanded={open}>
				<span className="chk">{open ? "▾" : "▸"}</span>
				<span className="fsvc">{f.service}</span>
				<span className="fres" title={f.resource}>{f.resource}</span>
				<span className="fcost">{cost !== null ? `${fmt$(cost)}/mo` : <em className="dim">n/a</em>}</span>
				<span className="fsave">{fmt$(f.est_monthly_saving_usd)}/mo</span>
			</button>
			{open && (
				<div className="frow-detail">
					<div className="dgrid">
						<div><label>Category</label><p>{f.category}</p></div>
						<div><label>Current cost</label><p>{cost !== null ? `${fmt$(cost)}/mo` : "not in this window"}</p></div>
						<div><label>Est. savings</label><p className="green">{fmt$(f.est_monthly_saving_usd)}/mo · {fmt$(Number(f.est_monthly_saving_usd) * 12)}/yr</p></div>
					</div>
					{metaLine(f) && <p className="dmeta">{metaLine(f)}</p>}
					<p className="ddetail"><b>Detail</b> {f.detail}</p>
					{f.rec ? (
						<EnginePlan
							rec={f.rec}
							narrative={narrative}
							busy={busy}
							err={err}
							onRetry={generate}
							hasJob={Boolean(jobId)}
						/>
					) : (
						<p className="drec"><b>Do this</b> {f.recommendation}</p>
					)}
					<p className="fnum dim">Finding #{seq}</p>
				</div>
			)}
		</div>
	);
}

/** Findings — only genuine savings (> $0/mo). */
export function FindingsSection({ m, total, jobId }: { m: Metrics; total: number; jobId: string | null }) {
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
					list.map((f, i) => <FindingRow key={`${f.resource}-${i}`} f={f} seq={i + 1} jobId={jobId} />)
				) : (
					<p className="mut">No findings match the filter.</p>
				)}
			</div>
		</section>
	);
}
