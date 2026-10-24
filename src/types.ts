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

export interface Finding {
	service: string;
	resource: string;
	category: string;
	detail: string;
	est_monthly_saving_usd: number;
	recommendation: string;
	meta?: FindingMeta;
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
