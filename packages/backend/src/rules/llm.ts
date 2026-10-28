/**
 * Grounded LLM summary layer.
 *
 * Design contract (do not weaken without a test):
 *   - The rule engine (rules/recs.ts) owns every number. This module never
 *     recomputes savings, prices or projections.
 *   - The model receives a frozen "facts" object per finding and writes a 1–2
 *     sentence summary that checks the rule output and names the action to take.
 *     `sanitizeNarrative()` rejects any text containing a figure absent from the
 *     facts, so a hallucinated dollar amount can never reach the report.
 *   - The layer is best-effort: no key, bad JSON, timeout or HTTP error means
 *     the finding keeps its deterministic rule text and the audit still
 *     completes. An LLM incident must never fail a scan.
 *
 * Enabled by setting OPENROUTER_API_KEY. Model is pinned via OPENROUTER_MODEL
 * (defaults to a free, deterministic slug — never `openrouter/free`, which is a
 * random router and would make report wording change between runs).
 */
import type { Finding, RecDetail, RecNarrative } from "../types";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "poolside/laguna-s-2.1:free";
const TIMEOUT_MS = 30_000;
/** Only the highest-value findings get a narrative; the rest keep rule text. */
const MAX_FINDINGS = 40;
/** Findings per request — small enough for free-tier context and reliable JSON. */
const BATCH_SIZE = 8;
/** Parallel requests. Free tiers rate-limit aggressively; stay conservative. */
const CONCURRENCY = 3;
const MAX_FIELD = 260;

const SYSTEM = `You are an AWS cost advisory editor. You receive FACTS about one resource from a deterministic rule engine.

Write ONE summary of 1–2 short sentences (max 240 characters) that:
1. Confirms whether the rule engine's diagnosis and selected action are credible given the measured evidence — say so plainly, and if evidence is missing, say what is missing.
2. States the concrete action to take to capture the saving, in plain words.

Hard rules:
1. Do NOT write any numbers, currency amounts, percentages, dates, durations or resource ids. Refer to figures qualitatively, e.g. "the calculated monthly saving", "the measured CPU average". The report already prints the exact figures from FACTS.
2. If something is not in FACTS, say "not measurable" instead of estimating.
3. No markdown, no bullet characters, no lists. Plain prose only.
4. Output JSON only, matching the requested schema.`;

const SCHEMA_HINT = `Return exactly:
{"items":[{"id":"<id from FACTS>","summary":"..."}]}`;

export interface LlmOptions {
	apiKey?: string | null;
	model?: string;
	timeoutMs?: number;
	/** Called with a short status line; never contains the API key. */
	log?: (msg: string) => void;
}

/** Resolve the key from an explicit option or the process environment. */
export function resolveApiKey(opts: LlmOptions = {}): string | null {
	if (opts.apiKey) return opts.apiKey;
	const env = typeof process !== "undefined" ? process.env : undefined;
	return env?.OPENROUTER_API_KEY?.trim() || null;
}

/** Resolve the pinned model slug. */
export function resolveModel(opts: LlmOptions = {}): string {
	if (opts.model) return opts.model;
	const env = typeof process !== "undefined" ? process.env : undefined;
	return env?.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
}

// ── facts & guardrail ───────────────────────────────────────────────────────

/** The frozen, minimal view of a finding that the model is allowed to see. */
export function factsOf(f: Finding): Record<string, unknown> {
	const r = f.rec;
	return {
		service: f.service,
		resource: f.resource,
		category: f.category,
		current_config: r?.current_config ?? f.detail,
		evidence: r?.evidence ?? [f.detail],
		options: (r?.options ?? []).map((o) => ({
			title: o.title,
			change: o.change,
			saving_mo: o.saving_mo,
			trade_off: o.trade_off,
		})),
		selected: r?.selected ?? 0,
		current_cost_mo: r?.current_cost_mo ?? null,
		projected_cost_mo: r?.projected_cost_mo ?? null,
		saving_mo: r?.saving_mo ?? f.est_monthly_saving_usd,
		calc_method: r?.calc_method ?? "",
		risks: r?.risks ?? [],
		data_gaps: r?.data_gaps ?? [],
	};
}

const NUM_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Every numeric token in `text`, normalized ("1,234.5" → "1234.5"). */
export function extractNumbers(text: string): string[] {
	return (text.match(NUM_RE) ?? []).map((n) => n.replace(/,/g, ""));
}

/**
 * True when every *financial* claim in `text` is grounded in `facts`.
 *
 * Strict on currency amounts and percentages — those are the claims that would
 * mislead a cost report — and lenient on other digits (instance types, ids,
 * version numbers), which the model copies from the facts anyway. This keeps
 * the gate meaningful without discarding otherwise-good prose.
 */
export function numbersAllowed(text: string, facts: Record<string, unknown>): boolean {
	const allowed = new Set(extractNumbers(JSON.stringify(facts)));
	const claims = [
		...[...text.matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?)/g)].map((m) => m[1]),
		...[...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*%/g)].map((m) => m[1]),
	].map((n) => n.replace(/,/g, ""));
	return claims.every((n) => allowed.has(n));
}

function clean(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const s = v.replace(/\s+/g, " ").trim();
	if (!s) return null;
	if (s.length <= MAX_FIELD) return s;
	// Prefer a whole sentence; fall back to the last word boundary.
	const cut = s.slice(0, MAX_FIELD);
	const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
	if (sentence > 80) return cut.slice(0, sentence + 1).trim();
	const word = cut.lastIndexOf(" ");
	return `${(word > 0 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/**
 * Validate one model item against the facts it was given.
 * Returns null when the shape is wrong or a financial figure was invented.
 */
export function sanitizeNarrative(
	raw: unknown,
	facts: Record<string, unknown>,
	model: string,
): RecNarrative | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	// `business_impact` is accepted as a legacy alias so older fixtures still work.
	const summary = clean(o.summary ?? o.business_impact);
	if (summary === null) return null;
	if (!numbersAllowed(summary, facts)) return null;
	return { summary, model };
}

// ── transport ───────────────────────────────────────────────────────────────

interface ChatResponse {
	choices?: { message?: { content?: unknown } }[];
}

function parseJsonContent(raw: unknown): unknown {
	let text = typeof raw === "string" ? raw.trim() : "";
	// Tolerate fenced or chatty free-model output.
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) text = fence[1].trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) text = text.slice(start, end + 1);
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function callModel(
	key: string,
	model: string,
	items: { id: string; facts: Record<string, unknown> }[],
	timeoutMs: number,
): Promise<unknown[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://github.com/Danishkohale/aws-cost-audit-dashboard",
				"X-Title": "AWS Cost Audit Dashboard",
			},
			body: JSON.stringify({
				model,
				temperature: 0.1,
				max_tokens: 1200,
				response_format: { type: "json_object" },
				messages: [
					{ role: "system", content: SYSTEM },
					{
						role: "user",
						content: `${SCHEMA_HINT}\n\nFACTS (one object per finding, keyed by id):\n${JSON.stringify(items)}`,
					},
				],
			}),
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}`);
		}
		const body = (await res.json()) as ChatResponse;
		const parsed = parseJsonContent(body.choices?.[0]?.message?.content);
		const list = (parsed as { items?: unknown })?.items;
		return Array.isArray(list) ? list : [];
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Attach `rec.narrative` to the highest-priority findings.
 *
 * Never throws. When disabled or unreachable, findings are returned unchanged
 * (same object identity is not guaranteed — a new array is always returned).
 */
export async function enrichWithLlm(
	findings: Finding[],
	opts: LlmOptions = {},
): Promise<Finding[]> {
	const key = resolveApiKey(opts);
	if (!key) {
		opts.log?.("[llm] skipped — OPENROUTER_API_KEY not set (rule text only)");
		return findings;
	}

	const model = resolveModel(opts);
	const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

	const candidates = findings
		.filter((f) => !!f.rec)
		.sort((a, b) => (b.rec?.priority_score ?? 0) - (a.rec?.priority_score ?? 0))
		.slice(0, MAX_FINDINGS);
	if (candidates.length === 0) return findings;

	const factsById = new Map<string, Record<string, unknown>>();
	const idOf = new Map<Finding, string>();
	candidates.forEach((f, i) => {
		const id = `f${i}`;
		factsById.set(id, factsOf(f));
		idOf.set(f, id);
	});

	const ids = [...factsById.keys()];
	const batches: string[][] = [];
	for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE));

	const narratives = new Map<string, RecNarrative>();
	let rejected = 0;

	const runBatch = async (batch: string[]) => {
		const call = async (retries: number): Promise<unknown[]> => {
			try {
				const items = batch.map((id) => ({
					id,
					facts: factsById.get(id) as Record<string, unknown>,
				}));
				return await callModel(key, model, items, timeoutMs);
			} catch (e) {
				// Free tiers return 429 aggressively — one short retry is worth it.
				if (retries > 0 && /HTTP 429/.test((e as Error).message)) {
					await new Promise((r) => setTimeout(r, 1500));
					return call(retries - 1);
				}
				throw e;
			}
		};
		try {
			const out = await call(1);
			const byId = new Map<string, unknown>();
			for (const it of out) {
				const id = (it as { id?: unknown })?.id;
				if (typeof id === "string") byId.set(id, it);
			}
			for (const id of batch) {
				const facts = factsById.get(id);
				if (!facts) continue;
				const ok = sanitizeNarrative(byId.get(id), facts, model);
				if (ok) narratives.set(id, ok);
				else rejected++;
			}
		} catch (e) {
			opts.log?.(`[llm] batch skipped — ${(e as Error).message}`);
		}
	};

	for (let i = 0; i < batches.length; i += CONCURRENCY) {
		await Promise.allSettled(batches.slice(i, i + CONCURRENCY).map(runBatch));
	}

	opts.log?.(
		`[llm] narrative added to ${narratives.size}/${candidates.length} findings` +
			(rejected > 0 ? ` (${rejected} rejected by numeric guardrail)` : "") +
			` via ${model}`,
	);

	return findings.map((f) => {
		const n = narratives.get(idOf.get(f) ?? "");
		return n ? { ...f, rec: { ...(f.rec as RecDetail), narrative: n } } : f;
	});
}
