/**
 * Shared domain types for the AWS Cost Audit dashboard.
 *
 * These mirror the JSON produced by the Python audit engine
 * (cost-optimization.py `payload` + audit_runner.py `summary`) so the existing
 * frontend and the golden tests keep the same shape.
 */

/** Free-form structured numbers attached to a finding (frontend renders these as chips). */
export interface FindingMeta {
	[key: string]: string | number | boolean | null;
}

/** One candidate remediation option produced by the recommendation engine. */
export interface RecOption {
	title: string;
	/** The specific change: target instance type, storage class, config, … */
	change: string;
	/** Estimated monthly saving for THIS option only, when computable. */
	saving_mo: number | null;
	trade_off: string;
}

/** Evidence-based remediation plan attached to a finding (see rules/recs.ts). */
export interface RecDetail {
	/** Resource configuration as observed (type/class/state/age/size). */
	current_config: string;
	/** The detected issue, one sentence. */
	issue: string;
	/** Supporting evidence bullets, straight from measured meta values. */
	evidence: string[];
	/** Viable alternatives, comparable by saving + trade-off. */
	options: RecOption[];
	/** Index into options[] of the recommended one. */
	selected: number;
	/** Why the selected option is the most cost-effective choice. */
	why_selected: string;
	/** The specific recommended change (redundant with options[selected].change). */
	change: string;
	/** Measured/estimated current monthly cost — null when unknown. */
	current_cost_mo: number | null;
	/** Projected monthly cost AFTER optimization — null when not computable. */
	projected_cost_mo: number | null;
	/** Net saving for the chosen option (arithmetic, not the scan rule-of-thumb). */
	saving_mo: number | null;
	saving_an: number | null;
	/** How the numbers were derived — always with the actual inputs shown. */
	calc_method: string;
	confidence: "high" | "medium" | "low";
	confidence_basis: string;
	risks: string[];
	/** What is missing for a reliable calculation — never silently invented. */
	data_gaps: string[];
	/** Present when rec.saving_mo differs from the scan's headline estimate. */
	estimate_note: string | null;
	priority_score: number;
	priority_band: "P1 — Do first" | "P2 — Schedule" | "P3 — When convenient";
	/** How estimated-vs-actual gets tracked after implementation. */
	tracking: string;
}

export interface Finding {
	service: string;
	resource: string;
	category: string;
	detail: string;
	est_monthly_saving_usd: number;
	recommendation: string;
	meta?: FindingMeta;
	/** Structured recommendation produced by the recommendation engine. */
	rec?: RecDetail;
}

export interface Payload {
	date: string;
	region: string;
	lookback_days: number;
	live_cost_by_service: Record<string, number>;
	cost_note: string;
	findings: Finding[];
}

export interface Summary {
	findings_count: number;
	total_savings: number;
	live_cost_total: number;
	region: string;
	date: string;
	lookback_days: number;
	cost_note: string;
	docx_available: boolean;
}

export type JobStatus = "queued" | "running" | "done" | "error";

export interface Job {
	job_id: string;
	status: JobStatus;
	progress: number;
	logs: string[];
	started_at?: string;
	finished_at?: string;
	summary?: Summary;
	error?: string;
	/** Present only when status === "done" (matches app.py safe_job_view). */
	payload?: Payload;
}

export type DownloadFormat = "json" | "html" | "docx";

/** AWS credentials stored temporarily for audit execution. */
export interface AwsCreds {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	region: string;
	days: number;
}
