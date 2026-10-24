/**
 * API layer — talks to the Render backend (Bun + Hono).
 * Base URL comes from VITE_API_BASE_URL (baked at build time).
 * Falls back to same-origin for local dev with a proxied backend.
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export function apiUrl(path: string): string {
	return `${API_BASE}${path}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(apiUrl(path), { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
	const ct = res.headers.get("content-type") || "";
	if (!ct.includes("application/json")) {
		throw new Error(`Server error ${res.status} — backend may be cold-starting. Retry in a minute.`);
	}
	const body = (await res.json()) as { error?: string } & T;
	if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
	return body;
}

// --- Types -------------------------------------------------------------------
export interface Finding {
	service: string;
	resource: string;
	category: string;
	detail: string;
	est_monthly_saving_usd: number;
	recommendation: string;
	meta?: Record<string, unknown>;
}

export interface Summary {
	findings_count: number;
	total_savings: number;
	live_cost_total: number;
	region: string;
	date: string;
	lookback_days: number;
	cost_note: string;
}

export interface Job {
	job_id: string;
	status: "queued" | "running" | "done" | "error";
	progress: number;
	logs: string[];
	summary?: Summary;
	error?: string;
	payload?: {
		date: string;
		region: string;
		lookback_days: number;
		live_cost_by_service: Record<string, number>;
		cost_note: string;
		findings: Finding[];
	};
}

export const startAudit = (body: {
	access_key_id: string;
	secret_access_key: string;
	session_token?: string;
	region: string;
	days: number;
}) => api<{ job_id: string }>("/api/audit", { method: "POST", body: JSON.stringify(body) });

export const runDemo = () => api<{ job_id: string }>("/api/demo", { method: "POST" });

export const getJob = (jobId: string) => api<Job>(`/api/audit/${jobId}`);

export { API_BASE, api };
