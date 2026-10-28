/**
 * Recommendation engine — evidence-based, resource-specific remediation plans.
 *
 * Runs AFTER the scanners. It never calls AWS again: it re-derives a full
 * structured recommendation from the metrics each scanner already collected
 * (Finding.meta) plus the price tables, so demo and live audits behave
 * identically.
 *
 * Honesty rules:
 *   - Every number in `calc_method` is computed from measured values or
 *     published-formula price tables; nothing is invented silently.
 *   - Missing inputs (no metrics, price outside the table, no access stats)
 *     are stated in `data_gaps` — never papered over.
 *   - The scan's headline `est_monthly_saving_usd` (used in totals) is never
 *     modified. `rec.saving_mo` is the specific arithmetic for the chosen
 *     option; when the two differ, `estimate_note` explains the difference.
 */
import type { Finding, FindingMeta, RecDetail, RecOption } from "../types";
import {
	EC2_PRICE_MO,
	RDS_PRICE_MO,
	EBS_GB_MO,
	SNAP_GB_MO,
	CW_INGEST_GB,
	CW_STORE_GB_MO,
} from "./pricing";
import { round2, money, pyNum } from "../report/format";

/** vCPU-size ladder used to walk an instance/class one step down. */
const SIZE_MP: Record<string, string> = {
	micro: "nano",
	small: "micro",
	medium: "small",
	large: "medium",
	xlarge: "large",
	"2xlarge": "xlarge",
	"4xlarge": "2xlarge",
	"8xlarge": "4xlarge",
	"9xlarge": "8xlarge",
	"10xlarge": "9xlarge",
	"12xlarge": "10xlarge",
	"16xlarge": "12xlarge",
	"24xlarge": "16xlarge",
	"32xlarge": "24xlarge",
};

/** Findings that need no remediation plan. */
const SKIP = /(OK —|Summary —|AccessIssue|Truncated)/;

const CONF_W = { high: 1, medium: 0.6, low: 0.35 } as const;
const RISK_W = { low: 1, medium: 0.85, high: 0.7 } as const;

const TRACKING =
	"Verify: re-run the audit after the change and compare actual vs estimated.";

const NAT_HOURLY = 0.045; // $/hr per NAT gateway
const EIP_HOURLY = 0.005; // $/hr per idle EIP
const EKS_CLUSTER_HOURLY = 0.1; // $/hr control plane

function num(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function usd(n: number | null | undefined): string {
	return n === null || n === undefined ? "unknown" : `$${money(n)}`;
}

/** Split an instance/class name into family ("t3", "db.r5") and size ("medium"). */
function splitClass(t: string): { family: string; size: string } | null {
	const i = t.lastIndexOf(".");
	if (i <= 0) return null;
	return { family: t.slice(0, i), size: t.slice(i + 1) };
}

/**
 * Probably-nonexistent sizes: most instance families and all RDS families
 * floor at "large" (no .small/.medium/.nano SKUs); t2/t3 go down to nano.
 */
function floorSize(family: string): string {
	return /^(t2|t3)/.test(family) ? "nano" : "large";
}

function belowFloor(family: string, size: string): boolean {
	const FLOOR: Record<string, number> = {
		nano: 0, micro: 1, small: 2, medium: 3, large: 4, xlarge: 5,
		"2xlarge": 6, "4xlarge": 7, "8xlarge": 8,
	};
	const f = FLOOR[size], fl = FLOOR[floorSize(family)];
	return f !== undefined && fl !== undefined && f < fl;
}

/** One or more sizes down within the same family (price is linear ×2 per step). */
function stepDown(type: string, steps = 1): { type: string; divisor: number } | null {
	const p = splitClass(type);
	if (!p) return null;
	let cur = p.size;
	let divisor = 1;
	for (let k = 0; k < steps; k++) {
		const nxt = SIZE_MP[cur];
		if (!nxt || belowFloor(p.family, nxt)) return null;
		cur = nxt;
		divisor *= 2;
	}
	return { type: `${p.family}.${cur}`, divisor };
}

/**
 * EC2 price: table lookup first; otherwise scale linearly (×2 per size step)
 * from a known sibling in the same family. Returns null when not derivable.
 */
function ec2PriceOf(type: string): number | null {
	if (EC2_PRICE_MO[type] !== undefined) return EC2_PRICE_MO[type];
	const p = splitClass(type);
	if (!p) return null;
	const siblings = Object.keys(EC2_PRICE_MO).filter((t) => t.startsWith(`${p.family}.`));
	for (const t of siblings) {
		let cur = p.size;
		let mul = 1;
		let steps = 0;
		while (cur !== splitClass(t)!.size && steps < 12) {
			const d = SIZE_MP[cur];
			if (!d) break;
			cur = d;
			mul *= 2;
			steps++;
		}
		if (cur === splitClass(t)!.size) return EC2_PRICE_MO[t] * mul;
	}
	return null;
}

function rdsPriceOf(cls: string, multiaz: boolean): number | null {
	if (RDS_PRICE_MO[cls] !== undefined) return RDS_PRICE_MO[cls] * (multiaz ? 2 : 1);
	const p = splitClass(cls);
	if (!p) return null;
	const siblings = Object.keys(RDS_PRICE_MO).filter((t) => t.startsWith(`${p.family}.`));
	for (const t of siblings) {
		let cur = p.size;
		let mul = 1;
		let steps = 0;
		while (cur !== splitClass(t)!.size && steps < 12) {
			const d = SIZE_MP[cur];
			if (!d) break;
			cur = d;
			mul *= 2;
			steps++;
		}
		if (cur === splitClass(t)!.size) return RDS_PRICE_MO[t] * (multiaz ? 2 : 1) * mul;
	}
	return null;
}

// ── description helpers (current config, evidence) ──────────────────────────

function metaCfg(f: Finding): string {
	const m = f.meta ?? {};
	const parts: string[] = [];
	const add = (v: unknown, label = "") => {
		if (v === null || v === undefined || v === "") return;
		parts.push(label ? `${label} ${v}` : String(v));
	};
	switch (f.service) {
		case "EC2":
			add(m.instance_type);
			add(m.az);
			add(m.age_days, "age");
			add(m.volumes, "EBS vols:");
			break;
		case "EBS":
		case "Snapshot":
			add(m.state);
			add(m.size_gb, "GB");
			add(m.type);
			add(m.az);
			add(m.attached_to, "attached to");
			add(m.age_days, "age");
			break;
		case "RDS":
			add(m.class);
			add(m.engine);
			add(m.multiaz === true ? "MultiAZ" : m.multiaz === false ? "SingleAZ" : null);
			add(m.storage_gb, "GB");
			add(m.storage_type);
			add(m.status);
			break;
		case "S3":
			add(m.size_gb, "GB");
			add(m.objects, "objects");
			add("lifecycle");
			add("versioning");
			break;
		case "CloudWatch":
			add(m.ingest_gb_day, "ingest GB/day:");
			add(m.stored_gb, "stored GB:");
			add(m.retention_days, "retention d:");
			break;
		case "VPC":
			add(m.subnet ?? m.az);
			break;
		case "ELB":
			add(m.type);
			add(m.scheme);
			add(m.age_days, "age");
			break;
	}
	return parts.join(" · ") || f.resource;
}

function evidence(f: Finding): string[] {
	const m = f.meta ?? {};
	const ev: string[] = [];
	const add = (cond: unknown, s: string) => {
		if (cond === null || cond === undefined) return;
		ev.push(s.replace("%v", String(cond)));
	};
	switch (f.service) {
		case "EC2":
			add(m.cpu_avg, "CPU avg %v% (max %v2%) over the window".replace("%v2", String(m.cpu_max ?? "?")));
			add(m.net_in_gb ?? m.net_out_gb, `Network in/out ${m.net_in_gb ?? "n/a"}/${m.net_out_gb ?? "n/a"} GB per window`);
			add(m.state, "Instance state: %v");
			add(m.age_days, "Age: %v days");
			break;
		case "EBS":
			add(m.state, "Volume state: %v");
			add(m.read_ops_14d ?? m.read_ops, `VolumeReadOps ${m.read_ops_14d ?? m.read_ops ?? "?"} / VolumeWriteOps ${m.write_ops_14d ?? m.write_ops ?? "?"} ops per window`);
			add(m.attached_to, "Attached to: %v");
			add(m.size_gb, "Size: %v GB");
			break;
		case "Snapshot":
			add(m.size_gb, "Size: %v GB");
			add(m.age_days, "Age: %v days");
			add(m.ami_linked === false ? "no AMI references this snapshot" : m.ami_linked === true ? "AMI-linked snapshot" : null, "Linkage: %v");
			break;
		case "RDS":
			add(m.cpu_avg, "CPU avg %v% over the window");
			add(m.conns_avg, "Avg DB connections: %v");
			add(m.multiaz, "MultiAZ: %v");
			add(m.status, "Status: %v");
			break;
		case "S3":
			add(m.size_gb, "Size: %v GB");
			add(m.objects, "Objects: %v");
			add(m.gets ?? m.puts, `Requests: GET ${m.gets ?? "?"} / PUT ${m.puts ?? "?"} per window`);
			add(m.lifecycle === false ? "no lifecycle rule" : m.lifecycle ? "lifecycle present" : null, "Policy: %v");
			break;
		case "CloudWatch":
			add(m.ingest_gb_day, "Ingestion: %v GB/day");
			add(m.stored_gb, "Stored: %v GB");
			add(m.retention_days ?? "never expires", "Retention: %v days");
			break;
		case "VPC":
			add(m.out_gb, "NAT bytes out: %v GB per window");
			break;
		default:
			ev.push(f.detail);
	}
	return ev.length > 0 ? ev : [f.detail];
}

function currentCost(f: Finding): number | null {
	const m = f.meta ?? {};
	for (const k of ["base_cost_mo", "est_cost_mo", "est_ingest_mo"]) {
		const n = num(m[k]);
		if (n !== null && n > 0) return n;
	}
	return null;
}

// ── record scaffolding ──────────────────────────────────────────────────────

function baseRec(f: Finding, cur: number | null): RecDetail {
	return {
		current_config: metaCfg(f),
		issue: "",
		evidence: evidence(f),
		options: [],
		selected: 0,
		why_selected: "",
		change: "",
		projected_cost_mo: null,
		current_cost_mo: cur,
		saving_mo: null,
		saving_an: null,
		calc_method: "",
		confidence: "medium",
		confidence_basis: "",
		risks: [],
		data_gaps: [],
		estimate_note: null,
		priority_score: 0,
		priority_band: "P3 — When convenient",
		tracking: TRACKING,
	};
}

function pickBest(rec: RecDetail, cur: number | null): void {
	if (rec.options.length === 0) return;
	let bi = 0;
	for (let i = 1; i < rec.options.length; i++) {
		const a = num(rec.options[i].saving_mo) ?? 0;
		const b = num(rec.options[bi].saving_mo) ?? 0;
		if (a > b) bi = i;
	}
	rec.selected = bi;
	const chosen = rec.options[bi];
	rec.change = chosen.change;
	rec.saving_mo = chosen.saving_mo;
	rec.projected_cost_mo = cur !== null ? round2(Math.max(0, cur - (num(chosen.saving_mo) ?? 0))) : null;
}

function finish(rec: RecDetail, f: Finding, risk: "low" | "medium" | "high", confBasis: string): RecDetail {
	const cur = rec.current_cost_mo;
	const headline = num(f.est_monthly_saving_usd) ?? 0;
	if (rec.saving_mo === null && rec.projected_cost_mo !== null && cur !== null) {
		rec.saving_mo = round2(Math.max(0, cur - rec.projected_cost_mo));
	}
	if (rec.saving_mo === null && rec.projected_cost_mo === null && headline > 0) {
		rec.saving_mo = round2(headline);
	}
	if (rec.saving_an === null && rec.saving_mo !== null) rec.saving_an = round2(rec.saving_mo * 12);
	if (!rec.calc_method) {
		rec.calc_method =
			cur !== null && rec.projected_cost_mo !== null
				? `${usd(cur)}/mo − ${usd(rec.projected_cost_mo)}/mo = ${usd(rec.saving_mo)}/mo`
				: headline > 0
					? `Scan rule-of-thumb: ${usd(headline)}/mo`
					: "No measured saving in this window — review only";
	}
	if (!rec.estimate_note && rec.saving_mo !== null && headline > 0 && Math.abs(rec.saving_mo - headline) > 0.015) {
		rec.estimate_note = `Headline rule-of-thumb ${usd(headline)}/mo vs option arithmetic ${usd(rec.saving_mo)}/mo — totals keep the lower figure.`;
	}
	rec.confidence_basis = confBasis;
	rec.priority_score = round2(((rec.saving_mo ?? 0) ?? 0) * CONF_W[rec.confidence] * RISK_W[risk]);
	rec.priority_band =
		rec.priority_score >= 20 ? "P1 — Do first" :
		rec.priority_score >= 4 ? "P2 — Schedule" : "P3 — When convenient";
	return rec;
}

// ── EC2 handlers ────────────────────────────────────────────────────────────

function ec2DownsizeRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const itype = String(m.instance_type ?? "?");
	const rec = baseRec(f, cur);
	const d1 = stepDown(itype, 1);
	const d3 = stepDown(itype, 3);
	const p1 = d1 ? ec2PriceOf(d1.type) ?? (cur !== null ? round2(cur / d1.divisor) : null) : null;
	const p3 = d3 ? ec2PriceOf(d3.type) ?? (cur !== null ? round2(cur / d3.divisor) : null) : null;
	const sched = cur !== null ? round2(cur * 0.58) : null; // 12h/weekday + all weekend ≈ 58% of compute hours

	rec.issue =
		`${itype}: CPU avg ${String(m.cpu_avg ?? "?")}% / max ${String(m.cpu_max ?? "?")}% — billed ${usd(cur)}/mo.`;
	rec.options = [];
	if (d1) rec.options.push({
		title: "Downsize one step",
		change: `${itype} → ${d1.type}`,
		saving_mo: p1 !== null && cur !== null ? round2(Math.max(0, cur - p1)) : null,
		trade_off: "Reboot ~2 min; same family.",
	});
	if (d3) rec.options.push({
		title: "Downsize three steps",
		change: `${itype} → ${d3.type}`,
		saving_mo: p3 !== null && cur !== null ? round2(Math.max(0, cur - p3)) : null,
		trade_off: "Needs p95 CPU below 50% of smaller size.",
	});
	if (sched !== null) rec.options.push({
		title: "Off-hours stop schedule",
		change: "Auto-stop 12h per weekday + all weekend (Instance Scheduler / EventBridge+Lambda on a stop-schedule tag)",
		saving_mo: sched,
		trade_off: "No business-hours downtime; re-point off-hours jobs.",
	});
	pickBest(rec, cur);
	rec.why_selected =
		rec.options[rec.selected] !== undefined
			? `Best saving: ${usd(rec.options[rec.selected].saving_mo)}/mo of ${usd(cur)}/mo (CPU avg ${m.cpu_avg ?? "?"}%).`
			: "";
	rec.confidence = m.cpu_avg != null ? "medium" : "low";
	const burstable = /^(t2|t3|t4g)\./.test(itype);
	rec.risks = [
		"Memory not measured — check CloudWatch Agent before deep cuts.",
		...(burstable ? ["Burstable CPU credits can run out — watch CPUCreditBalance."] : []),
		"Reboot required: pick a low-traffic window.",
	];
	if (m.cpu_avg == null) rec.data_gaps.push("No CPU metrics this window — options assume quiet usage.");
	if (d1 && EC2_PRICE_MO[d1.type] === undefined) rec.data_gaps.push(`${d1.type} list price not in local table — projected cost uses ×0.5-per-step pricing (${usd(cur !== null ? cur / d1.divisor : null)}/mo).`);
	return finish(rec, f, "medium", `CPU avg ${m.cpu_avg ?? "?"}% / max ${m.cpu_max ?? "?"}% from CloudWatch.`);
}

function ec2StoppedRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	rec.issue = "Stopped instance — still billed for attached EBS and reserved capacity.";
	rec.options = [
		{
			title: "Terminate + snapshot volumes",
			change: "Create final AMI if rollback matters → terminate instance → DLM 30–90d retention for the leftover volumes' snapshots",
			saving_mo: cur ?? round2(num(m.instance_type ? ec2PriceOf(String(m.instance_type)) : null) ?? 0),
			trade_off: "Full stop; snapshot keeps a cheap restore path.",
		},
		{
			title: "Delete volumes, keep instance stopped",
			change: "Snapshot each attached volume now, then delete the volumes immediately",
			saving_mo: null,
			trade_off: "Stops storage billing; instance can still be restarted.",
		},
		{
			title: "Start + right-size",
			change: "Start it and downsize one step (see the running-instance plan above) if the workload still exists",
			saving_mo: null,
			trade_off: "Only if the workload is genuinely alive.",
		},
	];
	rec.selected = 0;
	rec.change = rec.options[0].change;
	rec.saving_mo = rec.options[0].saving_mo;
	rec.projected_cost_mo = 0;
	rec.why_selected = cur !== null
		? `Stops the full ${usd(cur)}/mo; snapshots keep a rollback path.`
		: "Stops the waste; snapshots keep a rollback path.";
	rec.confidence = cur !== null ? "high" : "low";
	rec.risks = [
		"Data is unrecoverable without a snapshot — snapshot first.",
		"May be a parked staging/DR box — confirm with owner.",
	];
	if (cur === null) rec.data_gaps.push("EBS cost not in this window — real waste is higher.");
	else rec.data_gaps.push("Snapshot retention (~$0.05/GB/mo) is not subtracted from the saving.");
	return finish(rec, f, "medium", `State '${m.state ?? "stopped"}'; ${m.instance_type ?? "?"} priced at ${usd(cur)}/mo.`);
}

/** Previous-gen → current-gen same-size migration (m4→m5, c4→c5, r4→r5, t2→t3). */
function ec2OldGenRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const itype = String(m.instance_type ?? "?");
	const rec = baseRec(f, cur);
	const si = itype.indexOf(".");
	const curFamily = itype.slice(0, si);
	const newSize = itype.slice(si + 1);
	const newFamily = curFamily === "m4" ? "m5" : curFamily === "c4" ? "c5" : curFamily === "r4" ? "r5" : curFamily === "t2" ? "t3" : null;
	const sameSize = newFamily ? `${newFamily}.${newSize}` : null;
	const pSame = sameSize ? ec2PriceOf(sameSize) : null;
	const dz = stepDown(itype, 1);
	const pSameOneDown = dz && newFamily ? ec2PriceOf(`${newFamily}.${dz.type.slice(dz.type.indexOf(".") + 1)}`) : null;

	rec.issue = `Previous-gen ${itype} — current-gen is 10–20% cheaper at equal performance.`;
	rec.options = [];
	if (sameSize) rec.options.push({
		title: `Same-size migration ${curFamily} → ${newFamily}`,
		change: `${itype} → ${sameSize} (maintenance-window replacement, ENI/EIP swap)`,
		saving_mo: pSame !== null && cur !== null ? round2(Math.max(0, cur - pSame)) : null,
		trade_off: "Short replacement window.",
	});
	if (dz && newFamily) rec.options.push({
		title: "Migrate + downsize one step",
		change: `${itype} → ${newFamily}.${dz.type.slice(dz.type.indexOf(".") + 1)} (one generation newer AND one size smaller)`,
		saving_mo: pSameOneDown !== null && cur !== null ? round2(Math.max(0, cur - pSameOneDown)) : null,
		trade_off: "Largest saving; needs CPU-peak headroom.",
	});
	if (rec.options.length > 0) rec.options.push({
		title: "Migrate to Graviton",
		change: newFamily ? `${itype} → ${newFamily.toLowerCase().replace(/[^a-z0-9]/g, "") === "m5" ? "m7g" : "c7g"}.${newSize} (ARM)` : `${itype} → Graviton current-gen`,
		saving_mo: pSame !== null && cur !== null ? round2(Math.max(0, cur - pSame) * 1.15) : null,
		trade_off: "~15% more, but needs arm64 images.",
	});
	pickBest(rec, cur);
	rec.why_selected = rec.options[rec.selected] !== undefined
		? `Best saving: ${usd(rec.options[rec.selected].saving_mo)}/mo of ${usd(cur)}/mo.`
		: "";
	rec.confidence = pSame !== null && cur !== null ? "medium" : "low";
	rec.risks = [
		"Graviton needs amd64→arm64 rebuilds — only if that pipeline exists.",
	];
	if (pSame === null && cur !== null) rec.data_gaps.push(`${sameSize ?? "Current-gen"} price not in local table — uses the 10–20% scan band.`);
	return finish(rec, f, "medium", `Price-table comparison; CPU ${m.cpu_avg ?? "?"}% confirms headroom.`);
}

// ── EBS / EC2-Other handlers ────────────────────────────────────────────────

function ebsUnattachedRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const size = num(m.size_gb);
	const rate = EBS_GB_MO[String(m.type ?? "")] ?? EBS_GB_MO["gp2"] ?? 0.1;
	const snapMo = size !== null ? round2(size * SNAP_GB_MO) : null;
	rec.issue = "Volume detached ('available') — billed at full rate, serving nothing.";
	rec.options = [
		{
			title: "Snapshot then delete",
			change: size !== null
				? `Snapshot ${size}GB (~${usd(snapMo)}/mo retention) → delete volume after a 7–30d recovery window`
				: "Snapshot then delete the volume after a recovery window",
			saving_mo: cur !== null && snapMo !== null ? round2(Math.max(0, cur - snapMo)) : cur,
			trade_off: "Cheap rollback path; ~90% of the bill gone.",
		},
		{
			title: "Delete outright",
			change: "Delete the volume now (no snapshot)",
			saving_mo: cur,
			trade_off: "Maximum saving; irreversible.",
		},
	];
	pickBest(rec, cur);
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = rec.selected === 0 ? snapMo : 0;
	rec.why_selected = "Best saving: " + usd(rec.options[0].saving_mo) + "/mo; snapshot keeps a rollback path.";
	rec.confidence = cur !== null ? "high" : "medium";
	rec.calc_method = size !== null && cur !== null
		? `${size}GB × $${rate}/GB-mo = ${usd(cur)}/mo → ${usd(snapMo)}/mo for the snapshot`
		: "Snapshot $0.05/GB-mo vs volume rate";
	rec.risks = [
		"Deleting without a snapshot loses the data permanently.",
		"Automation may re-attach by volume ID — check CloudTrail.",
	];
	if (cur === null) rec.data_gaps.push("No per-GB cost for this volume type in this window.");
	return finish(rec, f, "medium", `State '${m.state ?? "available"}'; $${rate}/GB-mo from the price table.`);
}

function ebsLowIoRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const type = String(m.type ?? "gp3");
	const size = num(m.size_gb);
	const attached = m.attached_to ? String(m.attached_to) : "";
	rec.issue = `${type} volume${attached ? ` on ${attached}` : ""} — near-zero I/O, still billed.`;
	rec.options = [
		{
			title: type === "gp2" ? "Modify gp2 → gp3" : "Shrink to gp3 at measured need",
			change: size !== null
				? `Re-provision to gp3 sized from p99 IOPS (3,000 IOPS / 125 MB/s baseline is free)`
				: "Re-provision to gp3 sized from p99 IOPS",
			saving_mo: cur !== null ? round2(cur * 0.5) : null,
			trade_off: "Stays attached; snapshot before shrinking.",
		},
		{
			title: "Archive cold data",
			change: "Snapshot → copy cold blocks to S3 Glacier → delete or shrink the volume",
			saving_mo: null,
			trade_off: "Only if data is truly cold; retrieval adds fees.",
		},
	];
	pickBest(rec, cur);
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = cur !== null ? round2(cur / 2) : null;
	rec.why_selected = "I/O near zero; cheapest safe match to measured demand.";
	rec.confidence = cur !== null ? "medium" : "low";
	rec.risks = [
		"A quiet fortnight can hide a monthly job — widen the window.",
	];
	if (attached) rec.data_gaps.push(`Host ${attached} may itself be idle — check its own finding.`);
	if (cur === null) rec.data_gaps.push("Per-GB rate for this type unknown.");
	return finish(rec, f, "medium", `ReadOps ${m.read_ops_14d ?? m.read_ops ?? "?"} / WriteOps ${m.write_ops_14d ?? m.write_ops ?? "?"} per window.`);
}

function ebsGp2Rec(f: Finding, cur: number | null, rds: boolean): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const size = num(m.size_gb);
	const gp3rate = rds ? 0.085 : EBS_GB_MO.gp3;
	const gp2rate = rds ? 0.115 : EBS_GB_MO.gp2;
	const proj = size !== null ? round2(size * gp3rate) : cur !== null ? round2(cur * (gp3rate / gp2rate)) : null;
	const saving = proj !== null
		? (cur !== null ? round2(Math.max(0, cur - proj)) : size !== null ? round2(size * (gp2rate - gp3rate)) : null)
		: null;
	rec.issue = `gp2${rds ? " RDS" : ""} storage${size !== null ? ` ${size}GB` : ""} — gp3 is ~20-25% cheaper, online.`;
	rec.options = [
		{
			title: "Modify gp2 → gp3",
			change: size !== null ? `Change storage type to gp3 (${size}GB${rds ? " in the maintenance window" : ", online"})` : "Change storage type to gp3",
			saving_mo: saving,
			trade_off: rds ? "RDS: maintenance window." : "Online, no reboot.",
		},
		{
			title: "gp3 + autoscaling",
			change: "Switch to gp3 and enable storage autoscaling so future growth no longer over-provisions",
			saving_mo: saving,
			trade_off: "Same saving; prevents future over-provisioning.",
		},
	];
	rec.selected = 1;
	rec.change = rec.options[1].change;
	rec.projected_cost_mo = proj;
	rec.saving_mo = rec.options[1].saving_mo;
	rec.why_selected = "Same saving as option 1; autoscaling prevents size drift.";
	rec.confidence = "high";
	rec.calc_method = size !== null && cur !== null
		? `${size}GB × ($${money(gp2rate)} − $${money(gp3rate)})/GB-mo = ${usd(round2(size * (gp2rate - gp3rate)))}/mo (${usd(cur)} → ${usd(proj)}/mo)`
		: `Rate drop $${money(gp2rate)} → $${money(gp3rate)}/GB-mo (≈20%)`;
	rec.risks = [
		rds ? "gp3 IOPS/throughput must cover the DB's p99 load." : "gp3 baseline 3,000 IOPS / 125 MB/s — re-provision if exceeded.",
	];
	rec.data_gaps = [
		"Per-GB prices vary by region — arithmetic uses ap-south-1.",
	];
	return finish(rec, f, "low", "Published per-GB rates on the measured size.");
}

function eipRec(f: Finding, cur: number | null): RecDetail {
	const rec = baseRec(f, cur);
	rec.issue = "Elastic IP not associated — billed hourly with or without traffic.";
	rec.options = [
		{
			title: "Release the address",
			change: "EC2 console → Elastic IPs → Release this address",
			saving_mo: cur ?? round2(EIP_HOURLY * 730),
			trade_off: "Same IP not guaranteed later — prefer DNS.",
		},
	];
	rec.selected = 0;
	rec.change = rec.options[0].change;
	rec.projected_cost_mo = 0;
	rec.saving_mo = rec.options[0].saving_mo;
	rec.why_selected = "No benefit while idle; release is instant and free.";
	rec.confidence = "high";
	rec.calc_method = `$${EIP_HOURLY}/hr × 730h = ${usd(round2(EIP_HOURLY * 730))}/mo removed`;
	rec.risks = ["Hard-coded IP references break — prefer a DNS name."];
	return finish(rec, f, "low", "Published idle EIP rate.");
}

function snapshotRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const size = num(m.size_gb);
	const isLarge = f.category.startsWith("Review");
	rec.issue = isLarge
		? "Old, unlinked, large snapshot — no AMI reference, still billed."
		: "Old unlinked snapshot — no AMI reference, likely retained by accident.";
	rec.options = [
		{
			title: "Delete + enforce DLM retention",
			change: `Delete this snapshot, then apply a Data Lifecycle Manager policy (30–90d auto-expiry) to the whole set`,
			saving_mo: size !== null ? round2(size * SNAP_GB_MO) : cur,
			trade_off: "DLM prevents the pattern recurring.",
		},
		{ title: "Delete only this one", change: "Delete the snapshot now (no policy change)", saving_mo: null, trade_off: "Fast; recurs next quarter." },
	];
	rec.selected = 0;
	rec.change = rec.options[0].change;
	rec.projected_cost_mo = 0;
	rec.saving_mo = rec.options[0].saving_mo;
	rec.why_selected = "Captures the saving and stops recurrence via DLM.";
	rec.confidence = "high";
	rec.calc_method = size !== null
		? `${size}GB × $${SNAP_GB_MO}/GB-mo = ${usd(round2(size * SNAP_GB_MO))}/mo → $0`
		: "Snapshot rate $0.05/GB-mo";
	rec.risks = [
		"Compliance may require this snapshot — verify policy.",
	];
	return finish(rec, f, "low", "ami_linked = false from describe; published rate × measured size.");
}

// ── RDS handlers ────────────────────────────────────────────────────────────

function rdsDownsizeRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const cls = String(m.class ?? "?");
	const rec = baseRec(f, cur);
	const maz = m.multiaz === true;
	const d1 = stepDown(cls, 1);
	const d3 = stepDown(cls, 3);
	const p1 = d1 ? rdsPriceOf(d1.type, maz) ?? (cur !== null ? round2(cur / d1.divisor) : null) : null;
	const p3 = d3 ? rdsPriceOf(d3.type, maz) ?? (cur !== null ? round2(cur / d3.divisor) : null) : null;
	rec.issue = `${cls}: CPU ${m.cpu_avg ?? "?"}% / conns ${m.conns_avg ?? "?"} — oversized.`;
	rec.options = [];
	if (d1) rec.options.push({
		title: "Downsize one step",
		change: `${cls} → ${d1.type}${maz ? " (MultiAZ stays on — both AZs resized)" : ""}`,
		saving_mo: p1 !== null && cur !== null ? round2(Math.max(0, cur - p1)) : null,
		trade_off: "Reboot in the maintenance window.",
	});
	if (d3) rec.options.push({
		title: "Downsize deeper (3 steps)",
		change: `${cls} → ${d3.type}`,
		saving_mo: p3 !== null && cur !== null ? round2(Math.max(0, cur - p3)) : null,
		trade_off: "Needs 30d low usage + max_connections check.",
	});
	if (maz || Number(m.cpu_avg) < 10) rec.options.push({
		title: "Aurora Serverless v2 switch",
		change: "Migrate to Aurora Serverless v2 (same engine) — capacity auto-scales in 0.5 ACU steps to actual load",
		saving_mo: cur !== null ? round2(cur * 0.7) : null,
		trade_off: "Data copy + cutover; ends pay-for-peak.",
	});
	pickBest(rec, cur);
	rec.why_selected = rec.options[rec.selected] !== undefined
		? `Best saving: ${usd(rec.options[rec.selected].saving_mo)}/mo of ${usd(cur)}/mo.`
		: "";
	rec.confidence = m.cpu_avg != null && m.conns_avg != null ? "medium" : "low";
	rec.risks = [
		"Resize reboots in the maintenance window.",
		"max_connections shrinks — verify app pool + autoscale.",
	];
	rec.data_gaps = [
		"Memory not measured (no Performance Insights) — check before resizing.",
	];
	if (cur === null) rec.data_gaps.push("Instance price unknown in this window.");
	return finish(rec, f, "medium", `CPU ${m.cpu_avg ?? "?"}% / conns ${m.conns_avg ?? "?"} measured${p1 !== null ? "; target price from family-linear pricing" : ""}.`);
}

function rdsStoppedRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const storageGb = num(m.storage_gb);
	const keepCost = storageGb !== null ? round2(storageGb * 0.095) : null;
	rec.issue = "Stopped RDS — storage + backups still bill; auto-restart after 7 days.";
	rec.options = [
		{
			title: "Final snapshot then delete",
			change: `Take a final snapshot and delete the ${m.engine ?? "DB"} instance${storageGb !== null ? ` (${storageGb}GB storage)` : ""}`,
			saving_mo: cur,
			trade_off: `Snapshot keeps data at ~${usd(keepCost)}/mo.`,
		},
		{ title: "Keep stopped", change: "Leave stopped for a planned return (storage keeps billing; auto-restart kicks in at 7 days)", saving_mo: null, trade_off: "Only for a short, deliberate pause." },
	];
	rec.selected = 0;
	rec.change = rec.options[0].change;
	rec.projected_cost_mo = keepCost;
	rec.saving_mo = cur;
	rec.why_selected = "Stops compute + instance charges; data stays at snapshot rate.";
	rec.confidence = "high";
	rec.calc_method = cur !== null
		? `${usd(cur)}/mo → ${usd(keepCost)}/mo snapshot ⇒ ${usd(keepCost !== null ? round2(cur - keepCost) : cur)}/mo`
		: "Running cost from price table; snapshot $0.095/GB-mo";
	rec.risks = [
		"Startup scripts / app configs referencing the DB will break.",
		"Restore needs the parameter group, option group and network context.",
	];
	if (keepCost !== null) rec.data_gaps.push(`Snapshot cost ~${usd(keepCost)}/mo is not subtracted from the headline saving.`);
	return finish(rec, f, "medium", `Status '${m.state ?? "stopped"}'; class + storage from describe.`);
}

// ── Network / load balancing / EKS / secrets / CW / S3 handlers ─────────────

function elbRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const reqs = num(m.requests);
	const isNoTargets = f.category.includes("No healthy targets");
	const base24 = round2(0.0225 * 730); // typical ALB hourly base
	rec.issue = isNoTargets
		? `No healthy targets (${m.healthy ?? 0} healthy / ${m.unhealthy ?? "?"} unhealthy) — still billed.`
		: `Near-zero traffic (${reqs ?? "n/a"} requests) — fixed base + LCU billed.`;
	rec.options = [
		{
			title: isNoTargets ? "Delete the load balancer" : "Delete after consolidating listeners",
			change: isNoTargets
				? `Delete ${String(m.type ?? "ALB")} and its target groups (fix targets first if the service should exist)`
				: "Move listeners onto an active ALB via listener rules (host/path), then delete this one",
			saving_mo: cur ?? base24,
			trade_off: "Re-point DNS first.",
		},
		{
			title: "Fix target health instead",
			change: isNoTargets ? "Repair the registered targets (their health check path/port/SG) and keep the LB in service" : "",
			saving_mo: null,
			trade_off: "Only if the service is still needed.",
		},
	];
	pickBest(rec, cur);
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = 0;
	rec.saving_mo = cur ?? base24;
	rec.why_selected = "Base + LCU charges stop immediately on delete.";
	rec.confidence = cur !== null ? "high" : "medium";
	rec.calc_method = cur !== null
		? `${usd(cur)}/mo → $0 on delete`
		: `ALB base $0.0225/hr × 730h ≈ ${usd(base24)}/mo + LCU`;
	rec.risks = [
		"Anything still sending requests here breaks — confirm first.",
	];
	if (cur === null) rec.data_gaps.push("LCU not measured — bill is base + LCU.");
	return finish(rec, f, "medium", `${m.healthy ?? "?"} healthy / ${m.unhealthy ?? "?"} unhealthy, ${reqs ?? "n/a"} requests.`);
}

function natRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const outGb = num(m.out_gb) ?? 0;
	const dataProcMo = round2(outGb * NAT_HOURLY); // out_gb is already window-aggregated GB
	const baseMo = round2(NAT_HOURLY * 730);
	const idle = f.category.startsWith("Idle");
	rec.issue = idle
		? `NAT: ${outGb}GB out per window — the $${NAT_HOURLY}/hr base dominates.`
		: `Low-traffic NAT — fixed hourly base dominates.`;
	rec.options = idle ?
		[
			{
				title: "Delete the NAT gateway",
				change: "VPC console → NAT gateways → delete, then remove the private route-table route that points at it",
				saving_mo: round2(baseMo + dataProcMo),
				trade_off: "Check route tables first — egress stops.",
			},
			{
				title: "Replace with VPC endpoints",
				change: "Add S3 + DynamoDB gateway endpoints (free) or interface endpoints ($0.01/hr per AZ) for only the S3/DDB traffic, then delete the NAT",
				saving_mo: round2(baseMo * 0.75 + dataProcMo),
				trade_off: "AWS traffic stays private; other egress needs a NAT.",
			},
		] :
		[
			{
				title: "Consolidate single-AZ",
				change: "Drop one of two NATs if its AZ carries minimal traffic and cross-AZ resilience can be relaxed there",
				saving_mo: round2(baseMo + dataProcMo * 0.5),
				trade_off: "Reduces AZ fault-tolerance for egress.",
			},
			{
				title: "Add S3/DynamoDB VPC endpoints",
				change: "Gateway endpoints for S3+DynamoDB (free) — their traffic stops flowing through the NAT",
				saving_mo: round2(outGb * NAT_HOURLY * 0.6),
				trade_off: "Free; narrows per-GB charges to non-AWS traffic.",
			},
		];
	pickBest(rec, cur);
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = cur !== null && rec.saving_mo !== null ? round2(Math.max(0, cur - rec.saving_mo)) : null;
	rec.why_selected = rec.options[rec.selected].title === "Replace with VPC endpoints"
		? "Free endpoints keep AWS access; the NAT base also disappears."
		: "The hourly base is unavoidable while the NAT exists.";
	rec.confidence = "high";
	rec.calc_method = cur !== null
		? `${usd(cur)}/mo → $0 (or ${usd(rec.projected_cost_mo)} with endpoints); ${outGb}GB processing included`
		: `$${NAT_HOURLY}/hr × 730h = ${usd(baseMo)}/mo + ${outGb}GB processing`;
	rec.risks = [
		"Release the NAT's Elastic IP separately (else $3.65/mo).",
		"Dependent private subnets lose egress.",
	];
	return finish(rec, f, "medium", `Bytes-out ${outGb}GB; base $${NAT_HOURLY}/hr published.`);
}

function eksRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const noNg = f.category.includes("No nodegroups");
	const oldV = f.category.includes("Old K8s");
	if (noNg) {
		const baseMo = round2(EKS_CLUSTER_HOURLY * 730);
		rec.issue = "EKS cluster with no nodegroups or workloads — control-plane still billed.";
		rec.options = [
			{ title: "Delete the cluster", change: "EKS console → delete cluster + its leftover ELBs/volumes/ENIs", saving_mo: cur ?? baseMo, trade_off: "Rebuild later via IaC; state lost." },
			{ title: "Keep control plane only", change: "If workloads return soon, keep the control plane and add Fargate profiles when needed", saving_mo: null, trade_off: "$73/mo continues." },
		];
		rec.selected = 0; rec.change = rec.options[0].change;
		rec.saving_mo = cur ?? baseMo; rec.projected_cost_mo = 0;
		rec.why_selected = "Idle control plane produces nothing; delete and rebuild from IaC.";
		rec.confidence = cur !== null ? "high" : "medium";
		rec.calc_method = cur !== null ? `${usd(cur)}/mo → $0 on delete` : `$${EKS_CLUSTER_HOURLY}/hr × 730h = ${usd(baseMo)}/mo`;
		rec.risks = ["Delete leftover ALBs/volumes in the VPC too."];
		rec.data_gaps = ["Worker instance hours not found in this scan."];
		return finish(rec, f, "medium", `No nodegroups from describe; $${EKS_CLUSTER_HOURLY}/hr published.`);
	}
	if (oldV) {
		rec.issue = "EOL Kubernetes version — extended-support surcharge applies.";
		rec.options = [
			{ title: "In-place upgrade to 1.28+", change: "Bump control-plane version, then update each nodegroup AMI", saving_mo: null, trade_off: "Needs pod-disruption scheduling." },
			{ title: "Upgrade + demote to Fargate Spot", change: "Upgrade version AND move non-critical workloads to Fargate Spot (~70% cheaper per pod)", saving_mo: null, trade_off: "Spot evictions with 2min notice." },
		];
		rec.selected = 1; rec.change = rec.options[1].change;
		rec.saving_mo = cur; rec.projected_cost_mo = cur !== null ? round2(Math.max(0, cur - (rec.saving_mo ?? 0))) : null;
		rec.why_selected = "Upgrade removes the surcharge; Fargate Spot cuts compute.";
		rec.confidence = "medium"; rec.data_gaps = ["Surcharge rate depends on EOL phase and region — headline is conservative."];
		rec.risks = ["Check removed APIs in manifests before the jump."];
		return finish(rec, f, "medium", `Version v${String(m.version ?? "?")}; extended support $0.50/hr over standard.`);
	}
	rec.issue = "Nodegroup oversized — idle instance-hours vs actual demand.";
	// Derive the compute bill from the declared nodegroup shape + published price.
	const types = Array.isArray(m.instance_types) ? m.instance_types : [];
	const nodes = num(m.desired_size) ?? 1;
	const nodeType = typeof types[0] === "string" ? types[0] : null;
	const nodePrice = nodeType ? ec2PriceOf(nodeType) : null;
	const derived = nodePrice !== null ? round2(nodes * nodePrice) : null;
	const curBill = cur ?? derived;
	if (curBill !== null) rec.current_cost_mo = curBill;
	rec.options = [
		{ title: "Karpenter + consolidation", change: "Deploy Karpenter with bin-packing consolidation and a right-sized instance set", saving_mo: curBill !== null ? round2(curBill * 0.7) : null, trade_off: "New controller to operate." },
		{ title: "Spot for stateless", change: "Move stateless deployments to Spot (or Fargate Spot) with graceful-drain PDBs", saving_mo: curBill !== null ? round2(curBill * 0.6) : null, trade_off: "Spot evictions — needs resume-tolerant design." },
	];
	rec.selected = 0; rec.change = rec.options[0].change;
	rec.saving_mo = rec.options[0].saving_mo;
	rec.projected_cost_mo = curBill !== null ? round2(Math.max(0, curBill - (rec.saving_mo ?? 0))) : null;
	rec.why_selected = "Widest saving coverage; can add Spot later.";
	rec.confidence = "low";
	rec.data_gaps = nodePrice !== null
		? [`Waste share unknown — bill derived from nodegroup (${nodes} × ${nodeType} at ${usd(nodePrice)}/mo = ${usd(curBill)}/mo) with a 70% consolidation assumption.`]
		: ["Nodegroup bill and waste share unknown — treat estimates as an upper bound."];
	rec.risks = ["Old AMIs may block Karpenter; review PodDisruptionBudgets before evictions."];
	return finish(rec, f, "medium", `Nodegroup: ${nodes} × ${nodeType ?? "?"} at ${usd(nodePrice ?? null)}/mo.`);
}

function secretRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	rec.issue = "Secret unaccessed 90+ days — billed per secret, no consumer.";
	rec.options = [
		{ title: "Delete (recoverable)", change: "Delete the secret — recoverable 7–30 days", saving_mo: cur ?? 0.4, trade_off: "Recovery window is the only warning." },
		{ title: "Consolidate", change: "Merge single-field secrets into one structured secret", saving_mo: null, trade_off: "Drops redundant per-secret charges." },
	];
	rec.selected = 0; rec.change = rec.options[0].change;
	rec.projected_cost_mo = 0; rec.saving_mo = rec.options[0].saving_mo;
	rec.why_selected = "Dead secret = cost + security liability; deletion is reversible.";
	rec.confidence = "high";
	rec.calc_method = "$0.40/secret/mo → $0 on delete";
	rec.risks = [
		"CloudTrail may miss third-party reads if the audit role lacks scope.",
	];
	return finish(rec, f, "low", `Last accessed ${m.last_accessed ?? ">90d ago"} from describe_secret; rate $0.40/secret/mo published.`);
}

function cwRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const ingestD = num(m.ingest_gb_day) ?? 0;
	const storedGb = num(m.stored_gb) ?? 0;
	const ingestMo = ingestD > 0 ? round2(ingestD * 30 * CW_INGEST_GB) : null;
	rec.issue = m.retention_days
		? `Ingest ${ingestD}GB/day — ingestion rate dominates the bill.`
		: "No retention set — logs accumulate at storage rate.";
	const isHigh = f.category.includes("High ingestion");
	if (isHigh) {
		rec.options = [
			{ title: "Sample + metric-filters", change: "Cut DEBUG at source libraries and emit CloudWatch metric filters instead of full log lines", saving_mo: ingestMo ?? cur, trade_off: "Metrics kept; per-event detail lost for sampled classes." },
			{ title: "Export to S3 + retain 7d in CW", change: "Ship full logs to S3 (much cheaper retention chain) and cap the CloudWatch copy at 7d", saving_mo: ingestMo !== null ? round2(ingestMo * 0.3) : null, trade_off: "Search moves to Athena/Glacier." },
		];
	} else {
		rec.options = [
			{ title: "Set retention 30–90d", change: "Logs console → per-group retention policy → 30–90d (operational groups 30d, security 90d+)", saving_mo: cur, trade_off: "Export to S3 first — expiry is permanent." },
			{ title: "Retention + DEBUG cut", change: "Same retention, plus cut DEBUG at source to shrink ingest too", saving_mo: null, trade_off: "Also lowers per-GB ingest." },
		];
	}
	pickBest(rec, cur);
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = rec.selected === 0 && !isHigh && ingestMo !== null
		? round2(Math.min(ingestMo, ingestD * 30 * CW_STORE_GB_MO)) // capped at 30 days of stored ingest
		: null;
	rec.why_selected = isHigh
		? "Ingest is the dominant line item; source-level verbosity is the only real cut."
		: "Retention bound is the one-change fix for storage growth.";
	rec.confidence = "medium";
	rec.calc_method = isHigh
		? `${ingestD}GB/day × $${CW_INGEST_GB}/GB ⇒ ${usd(ingestMo)}/mo ingest`
		: `${storedGb}GB × $${CW_STORE_GB_MO}/GB-mo ⇒ ${usd(cur)}/mo; 30d retention caps stored volume`;
	rec.risks = [
		"Early expiry erases forensics — export 90d to S3 first.",
	];
	return finish(rec, f, "low", `Ingest ${ingestD}GB/day, stored ${storedGb}GB; rates $${CW_INGEST_GB} / $${CW_STORE_GB_MO} per GB.`);
}

function s3Rec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const sizeGb = num(m.size_gb) ?? 0;
	const isIdle = f.category.includes("Near-empty");
	const isVersioned = f.category.includes("Versioned");
	const objects = num(m.objects);
	if (isIdle) {
		rec.issue = "Bucket near-empty, no requests — hygiene signal.";
		rec.options = [
			{ title: "Delete the bucket", change: "Confirm no app/IaC references the name, then empty and delete", saving_mo: cur ?? 0, trade_off: "Frees the S3 namespace." },
			{ title: "Keep + 7d expiry", change: "Apply a 7d object-expiry lifecycle to prove it stays unused, then delete", saving_mo: null, trade_off: "Cheap insurance against a consumer appearing." },
		];
		rec.selected = 0; rec.change = rec.options[0].change;
		rec.saving_mo = cur ?? 0; rec.projected_cost_mo = 0;
		rec.why_selected = "Near-zero size — deletion is safe; saving is hygiene, not dollars.";
		rec.confidence = "high";
		rec.calc_method = `${sizeGb}GB / ${objects ?? "?"} objects → $${money(cur ?? 0)}/mo → $0 on delete`;
		rec.risks = ["Check code/IaC references before removal."];
		return finish(rec, f, "low", `${sizeGb}GB / ${objects ?? "?"} objects, no lifecycle rule.`);
	}
	if (isVersioned) {
		const head = sizeGb !== null ? round2(Math.min(sizeGb * 0.4, 100)) : cur;
		rec.issue = "Versioning on, no noncurrent expiry — overwritten copies bill forever.";
		rec.options = [
			{ title: "Expire noncurrent versions", change: "Lifecycle rule: delete noncurrent versions after 30–90d + abort incomplete multipart uploads after 7d", saving_mo: cur ?? head, trade_off: "Pick days by restore-drill needs." },
		];
		rec.selected = 0; rec.change = rec.options[0].change;
		rec.saving_mo = rec.options[0].saving_mo; rec.projected_cost_mo = null;
		rec.why_selected = "Noncurrent versions duplicate current data.";
		rec.confidence = "medium";
		rec.calc_method = cur !== null
			? `${usd(cur)}/mo measured; ~40% of versioning overhead is redundant history (heuristic)`
			: "Noncurrent share unknown — list noncurrent versions";
		rec.risks = ["Aggressive day-counts erase restore points."];
		rec.data_gaps = ["No per-object access stats — refine retention after 30d of logs."];
		return finish(rec, f, "low", "Versioning enabled with no lifecycle rule.");
	}
	// No lifecycle policy
	const scanSaving = round2(Math.min(sizeGb * 0.01, 200));
	rec.issue = "No lifecycle policy — cold objects bill Standard rate.";
	rec.options = [
		{
			title: "Lifecycle rules (predictable)",
			change: "Expire noncurrent 30–90d; Standard→Standard-IA at 30d → Glacier regular at 90d; abort multipart 7d",
			saving_mo: scanSaving,
			trade_off: "Retrieval fees and wait times.",
		},
		{
			title: "Intelligent-Tiering",
			change: `Apply Intelligent-Tiering${objects !== null && objects < 500000 ? "" : " (8-tier auto-deciders)"}`,
			saving_mo: round2(Math.min(sizeGb * 0.008, 200)),
			trade_off: "No retrieval fees; small per-object monitoring fee.",
		},
	];
	rec.selected = objects !== null && objects > 1000000 ? 1 : 0;
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = cur !== null && rec.saving_mo !== null ? round2(Math.max(0, cur - rec.saving_mo)) : null;
	rec.why_selected = rec.selected === 1
		? "Millions of objects, unknown access — auto tiering beats hand-tuned rules."
		: "30/90d transitions are cheaper and predictable at this object count.";
	rec.confidence = "medium";
	rec.calc_method = cur !== null
		? `${usd(cur)}/mo Standard ⇒ ${usd(rec.projected_cost_mo)}/mo after tier shift; assumes ~35% goes cold`
		: `${sizeGb}GB × $0.023/GB ⇒ ${usd(round2(sizeGb * 0.023))}/mo today`;
	rec.risks = [
		"Glacier retrieval is per-GB and slow — plan before archiving critical data.",
	];
	rec.data_gaps = [
		"No per-object access stats — ~35% cold-share is a heuristic.",
	];
	return finish(rec, f, "medium", `${sizeGb}GB / ${objects ?? "?"} objects, no lifecycle rule, ${usd(cur)}/mo.`);
}

function vpnRec(f: Finding, cur: number | null): RecDetail {
	const rec = baseRec(f, cur);
	rec.issue = "Site-to-Site VPN near-zero traffic — $0.05/hr charges regardless.";
	rec.options = [
		{ title: "Delete the VPN connection + CGW", change: "VPC console → Site-to-Site VPN → delete connection and Customer Gateways", saving_mo: cur ?? round2(0.05 * 730), trade_off: "Re-setup needs partner coordination." },
	];
	rec.selected = 0; rec.change = rec.options[0].change;
	rec.projected_cost_mo = 0; rec.saving_mo = rec.options[0].saving_mo;
	rec.why_selected = "Idle tunnel: ~$36.5/mo for zero traffic.";
	rec.confidence = "high";
	rec.calc_method = `$0.05/hr × 730h = ${usd(round2(0.05 * 730))}/mo removed`;
	rec.risks = ["Re-establishing needs the far side's network team."];
	return finish(rec, f, "low", "Published VPN rate; near-zero traffic confirmed.");
}

function genericRec(f: Finding, cur: number | null): RecDetail {
	const rec = baseRec(f, cur);
	rec.issue = f.category.replace(/^[^—]+—\s*/, "") + " on this resource.";
	rec.options = [
		{ title: "Apply the recommended action", change: f.recommendation, saving_mo: num(f.est_monthly_saving_usd) ?? 0, trade_off: "Verify ownership first." },
	];
	rec.selected = 0;
	rec.change = f.recommendation;
	rec.saving_mo = num(f.est_monthly_saving_usd) ?? 0;
	rec.projected_cost_mo = cur !== null ? round2(Math.max(0, cur - (rec.saving_mo ?? 0))) : null;
	rec.why_selected = "Only modelled action for this finding type.";
	rec.confidence = "medium";
	rec.data_gaps = ["Finding type not fully modelled — numbers are rule-of-thumb."];
	rec.risks = ["Check ownership and dependencies first."];
	return finish(rec, f, "medium", "Rule-of-thumb from the scan engine.");
}

// ── dispatch ────────────────────────────────────────────────────────────────

function buildRec(f: Finding): RecDetail | null {
	const m: FindingMeta = f.meta ?? {};
	const cur = currentCost(f);
	if (f.service === "EC2" || f.service === "EC2-Instances") {
		if (f.category.includes("Stopped")) return ec2StoppedRec(f, cur);
		if (f.category.includes("Low CPU") || f.category.includes("Underutilized")) return ec2DownsizeRec(f, cur);
		if (f.category.includes("Old generation")) return ec2OldGenRec(f, cur);
		return null;
	}
	if (f.service === "EBS" || f.service === "EC2-Other") {
		if (f.category.includes("Unattached") || f.category.includes("Unassociated EBS")) return ebsUnattachedRec(f, cur);
		if (f.category.includes("Unassociated EIP") || f.category.includes("EIP")) return eipRec(f, cur);
		if (f.category.includes("Near-zero I/O") || f.category.includes("Oversized")) return ebsLowIoRec(f, cur);
		if (f.category.includes("gp2")) return ebsGp2Rec(f, cur, false);
		return null;
	}
	if (f.service === "Snapshot") return snapshotRec(f, cur);
	if (f.service === "RDS") {
		if (f.category.includes("Stopped")) return rdsStoppedRec(f, cur);
		if (f.category.includes("gp2 storage")) return ebsGp2Rec(f, cur, true);
		if (f.category.includes("Low use") || f.category.includes("Oversized") || f.category.includes("Old class")) return rdsDownsizeRec(f, cur);
		return null;
	}
	if (f.service === "ELB") return elbRec(f, cur);
	if (f.service === "VPC") {
		if (f.category.includes("NAT")) return natRec(f, cur);
		if (f.category.includes("VPN")) return vpnRec(f, cur);
		return null;
	}
	if (f.service === "EKS") return eksRec(f, cur);
	if (f.service === "Secrets Manager") return secretRec(f, cur);
	if (f.service === "CloudWatch") return cwRec(f, cur);
	if (f.service === "S3") return s3Rec(f, cur);
	return genericRec(f, cur);
}

/**
 * Enrich findings: attach a structured, evidence-based `rec` object to every
 * finding that needs a remediation plan; skip OK/summary rows. Resource IDs
 * and the headline savings are left untouched.
 */
export function enrichFindings(findings: Finding[]): Finding[] {
	return findings.map((f) => {
		if (SKIP.test(f.category)) return f;
		const rec = buildRec(f);
		if (!rec) return f;
		return { ...f, rec };
	});
}
