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
import type { Finding, RecDetail, RecOption } from "../types";
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
	"After applying the change, re-run this audit: this finding should disappear from the waste list and the dashboard's Actual-vs-Estimated panel will compare the measured saving against the estimate above.";

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
				? `Measured current ${usd(cur)}/mo − projected ${usd(rec.projected_cost_mo)}/mo after the change ⇒ ${usd(rec.saving_mo)}/mo`
				: headline > 0
					? `Scan rule-of-thumb: ${usd(headline)}/mo (headline figure; option arithmetic above is more specific)`
					: "No measured dollar saving in this window — review item only";
	}
	if (!rec.estimate_note && rec.saving_mo !== null && headline > 0 && Math.abs(rec.saving_mo - headline) > 0.015) {
		rec.estimate_note = `Headline estimate (rule-of-thumb used in the totals): ${usd(headline)}/mo. The chosen option's specific arithmetic gives ${usd(rec.saving_mo)}/mo — the totals keep the more conservative figure.`;
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
		`Running far below provisioned capacity: billed ${usd(cur)}/mo for a workload averaging ${String(m.cpu_avg ?? "?")}% CPU (max ${String(m.cpu_max ?? "?")}%).`;
	rec.options = [];
	if (d1) rec.options.push({
		title: "Downsize one step",
		change: `${itype} → ${d1.type}`,
		saving_mo: p1 !== null && cur !== null ? round2(Math.max(0, cur - p1)) : null,
		trade_off: "One reboot (~2 min); keeps same-family headroom for bursts.",
	});
	if (d3) rec.options.push({
		title: "Downsize three steps",
		change: `${itype} → ${d3.type}`,
		saving_mo: p3 !== null && cur !== null ? round2(Math.max(0, cur - p3)) : null,
		trade_off: "Deeper cut — only safe while peak CPU p95 < 50% of the smaller size.",
	});
	if (sched !== null) rec.options.push({
		title: "Off-hours stop schedule",
		change: "Auto-stop 12h per weekday + all weekend (Instance Scheduler / EventBridge+Lambda on a stop-schedule tag)",
		saving_mo: sched,
		trade_off: "No downtime in business hours; anything scheduled outside hours must be re-pointed.",
	});
	pickBest(rec, cur);
	rec.why_selected =
		rec.options[rec.selected] !== undefined
			? `${rec.options[rec.selected].title} yields the largest measured saving (${usd(rec.options[rec.selected].saving_mo)}/mo of ${usd(cur)}/mo) for this resource's observed CPU profile (avg ${m.cpu_avg ?? "?"}%, max ${m.cpu_max ?? "?"}%).`
			: "";
	rec.confidence = m.cpu_avg != null ? "medium" : "low";
	rec.risks = [
		"CPU metrics say nothing about memory — install CloudWatch Agent before deep downsizing.",
		"Burstable families (t2/t3) can exhaust CPU credits after a cut; watch CPUCreditBalance for a week.",
		"A reboot is required: pick the app's quietest hour.",
	];
	if (m.cpu_avg == null) rec.data_gaps.push("CPU metrics unavailable for this window — every option assumes the workload stays as quiet as the (missing) evidence suggests.");
	if (d1 && EC2_PRICE_MO[d1.type] === undefined) rec.data_gaps.push(`Exact list price for ${d1.type} is absent from the local price table — projected cost uses the family's linear ×0.5-per-step pricing (${usd(cur !== null ? cur / d1.divisor : null)}/mo); confirm on the AWS pricing page.`);
	return finish(rec, f, "medium", `CPU avg ${m.cpu_avg ?? "?"}% / max ${m.cpu_max ?? "?"}% measured from CloudWatch over the lookback window.`);
}

function ec2StoppedRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	rec.issue = "Stopped instance: still billed for attached EBS storage (and reserved for 0 compute output) since it stopped.";
	rec.options = [
		{
			title: "Terminate + snapshot volumes",
			change: "Create final AMI if rollback matters → terminate instance → DLM 30–90d retention for the leftover volumes' snapshots",
			saving_mo: cur ?? round2(num(m.instance_type ? ec2PriceOf(String(m.instance_type)) : null) ?? 0),
			trade_off: "Full full compute stop; snapshot retention keeps a cheap restore path (~$0.05/GB/mo).",
		},
		{
			title: "Delete volumes, keep instance stopped",
			change: "Snapshot each attached volume now, then delete the volumes immediately",
			saving_mo: null,
			trade_off: "Stops the storage bleed instantly if the instance may still be restarted later.",
		},
		{
			title: "Start + right-size",
			change: "Start it and downsize one step (see the running-instance plan above) if the workload still exists",
			saving_mo: null,
			trade_off: "Only better if the workload is genuinely alive; verify with the owner first.",
		},
	];
	rec.selected = 0;
	rec.change = rec.options[0].change;
	rec.saving_mo = rec.options[0].saving_mo;
	rec.projected_cost_mo = 0;
	rec.why_selected = cur !== null
		? `Terminating removes the full ${usd(cur)}/mo with no downside once the owner confirms no reuse; snapshots cover rollback at a fraction of the price.`
		: "Terminating removes the whole waste once confirmed; snapshots cover rollback cheaply.";
	rec.confidence = cur !== null ? "high" : "low";
	rec.risks = [
		"Volume data is unrecoverable after deletion without a snapshot — always snapshot first.",
		"The instance may be a staging/DR box someone parked deliberately; get owner confirmation.",
	];
	if (cur === null) rec.data_gaps.push("The audit window does not show this instance's EBS cost — the real waste is higher than shown.");
	else rec.data_gaps.push("Per-volume EBS cost is not broken out here; the snapshot-retention charge (~$0.05/GB/mo) is NOT subtracted from the saving figure.");
	return finish(rec, f, "medium", `State '${m.state ?? "stopped"}' confirmed in describe; ${m.instance_type ?? "?"} priced from the table at ${usd(cur)}/mo.`);
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

	rec.issue = `Previous-generation ${itype} — current-generation equivalents cost 10–20% less for equal or better performance.`;
	rec.options = [];
	if (sameSize) rec.options.push({
		title: `Same-size migration ${curFamily} → ${newFamily}`,
		change: `${itype} → ${sameSize} (maintenance-window replacement, ENI/EIP swap)`,
		saving_mo: pSame !== null && cur !== null ? round2(Math.max(0, cur - pSame)) : null,
		trade_off: "Instance replacement, not a hot resize — schedule a short window.",
	});
	if (dz && newFamily) rec.options.push({
		title: "Migrate + downsize one step",
		change: `${itype} → ${newFamily}.${dz.type.slice(dz.type.indexOf(".") + 1)} (one generation newer AND one size smaller)`,
		saving_mo: pSameOneDown !== null && cur !== null ? round2(Math.max(0, cur - pSameOneDown)) : null,
		trade_off: "Largest saving; needs the same CPU-peak evidence as any downsize.",
	});
	if (rec.options.length > 0) rec.options.push({
		title: "Migrate to Graviton",
		change: newFamily ? `${itype} → ${newFamily.toLowerCase().replace(/[^a-z0-9]/g, "") === "m5" ? "m7g" : "c7g"}.${newSize} (ARM)` : `${itype} → Graviton current-gen`,
		saving_mo: pSame !== null && cur !== null ? round2(Math.max(0, cur - pSame) * 1.15) : null,
		trade_off: "~15% cheaper again — but the binary/arch must support ARM; bigger validation scope.",
	});
	pickBest(rec, cur);
	rec.why_selected = rec.options[rec.selected] !== undefined
		? `${rec.options[rec.selected].title} captures the best measured saving (${usd(rec.options[rec.selected].saving_mo)}/mo of ${usd(cur)}/mo); generation migration is a one-off reversible change regardless.`
		: "";
	rec.confidence = pSame !== null && cur !== null ? "medium" : "low";
	rec.risks = [
		"ARM (Graviton) options need amd64→arm64 image rebuilds and dependency checks — pick them only when that pipeline exists.",
	];
	if (pSame === null && cur !== null) rec.data_gaps.push(`Price for ${sameSize ?? "the current-gen equivalent"} is not in the local table — the saving uses the 10–20% band from the scan's rule-of-thumb instead.`);
	return finish(rec, f, "medium", `Generation price band from the price table comparisons; measured CPU ${m.cpu_avg ?? "?"}% confirms headroom.`);
}

// ── EBS / EC2-Other handlers ────────────────────────────────────────────────

function ebsUnattachedRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const size = num(m.size_gb);
	const rate = EBS_GB_MO[String(m.type ?? "")] ?? EBS_GB_MO["gp2"] ?? 0.1;
	const snapMo = size !== null ? round2(size * SNAP_GB_MO) : null;
	rec.issue = "Volume is detached ('available') — billed at full storage rate while serving nothing.";
	rec.options = [
		{
			title: "Snapshot then delete",
			change: size !== null
				? `Snapshot ${size}GB (~${usd(snapMo)}/mo retention) → delete volume after a 7–30d recovery window`
				: "Snapshot then delete the volume after a recovery window",
			saving_mo: cur !== null && snapMo !== null ? round2(Math.max(0, cur - snapMo)) : cur,
			trade_off: "Keeps a cheap recovery path; ~90% of the bill goes away today.",
		},
		{
			title: "Delete outright",
			change: "Delete the volume now (no snapshot)",
			saving_mo: cur,
			trade_off: "Maximum saving; irreversible if the data mattered.",
		},
	];
	pickBest(rec, cur);
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = rec.selected === 0 ? snapMo : 0;
	rec.why_selected = "Snapshot-then-delete removes ~" + usd(rec.options[0].saving_mo) + "/mo while keeping a rollback path; pure deletion is available if the owner confirms zero value.";
	rec.confidence = cur !== null ? "high" : "medium";
	rec.calc_method = size !== null && cur !== null
		? `Cost is directly computed: ${size}GB × $${rate}/GB-mo = ${usd(cur)}/mo; after the change only the snapshot remains (${usd(snapMo)}/mo)`
		: "Snapshot rate $0.05/GB-mo vs volume rate";
	rec.risks = [
		"Deleting without a snapshot loses the data permanently.",
		"Some automation re-attaches EBS volumes by ID — check CloudTrail for recent attach activity before deleting.",
	];
	if (cur === null) rec.data_gaps.push("No per-GB cost computed for this volume type in this window — cost figure missing.");
	return finish(rec, f, "medium", `State '${m.state ?? "available"}' confirmed in describe; rate ${rate} $/GB-mo from the price table.`);
}

function ebsLowIoRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const type = String(m.type ?? "gp3");
	const size = num(m.size_gb);
	const attached = m.attached_to ? String(m.attached_to) : "";
	rec.issue = `Volume is attached${attached ? ` to ${attached}` : ""} but reads/writes almost nothing — paying ${type} price for idle storage.`;
	rec.options = [
		{
			title: type === "gp2" ? "Modify gp2 → gp3" : "Shrink to gp3 at measured need",
			change: size !== null
				? `Re-provision to gp3 sized from p99 IOPS (3,000 IOPS / 125 MB/s baseline is free)`
				: "Re-provision to gp3 sized from p99 IOPS",
			saving_mo: cur !== null ? round2(cur * 0.5) : null,
			trade_off: "Keeps it attached; snapshot first if shrinking below the data footprint.",
		},
		{
			title: "Archive cold data",
			change: "Snapshot → copy cold blocks to S3 Glacier → delete or shrink the volume",
			saving_mo: null,
			trade_off: "Only wins if the data is truly cold; retrieval takes minutes and adds per-GB fees.",
		},
	];
	pickBest(rec, cur);
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = cur !== null ? round2(cur / 2) : null;
	rec.why_selected = "Measured I/O is near zero; the cheapest safe move keeps the volume attached at a size that matches measured demand.";
	rec.confidence = cur !== null ? "medium" : "low";
	rec.risks = [
		"A quiet fortnight can hide a spiky monthly job — widen the metric window before shrinking.",
	];
	if (attached) rec.data_gaps.push(`Host instance ${attached} may itself be idle (see its own finding) — terminating that instance first is the simplest path.`);
	if (cur === null) rec.data_gaps.push("Per-GB rate for this volume type unknown in this window.");
	return finish(rec, f, "medium", `Measured VolumeReadOps ${m.read_ops_14d ?? m.read_ops ?? "?"} / write ${m.write_ops_14d ?? m.write_ops ?? "?"} ops per window.`);
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
	rec.issue = `Legacy ${rds ? "RDS storage" : ""} gp2 volume${size !== null ? ` (${size}GB)` : ""}: gp3 is ~20-25% cheaper at the same or configurable performance, and the change is online (no downtime).`;
	rec.options = [
		{
			title: "Modify gp2 → gp3",
			change: size !== null ? `Change storage type to gp3 (${size}GB${rds ? " in the maintenance window" : ", online"})` : "Change storage type to gp3",
			saving_mo: saving,
			trade_off: rds ? "RDS switch lands in a maintenance window; storage autoscaling should be enabled at the same time." : "Online, no snapshot, no reboot.",
		},
		{
			title: "gp3 + autoscaling",
			change: "Switch to gp3 and enable storage autoscaling so future growth no longer over-provisions",
			saving_mo: saving,
			trade_off: "Same saving now, plus protection against future over-provisioning.",
		},
	];
	rec.selected = 1;
	rec.change = rec.options[1].change;
	rec.projected_cost_mo = proj;
	rec.saving_mo = rec.options[1].saving_mo;
	rec.why_selected = "Identical saving to option 1 but with autoscaling it prevents the size drift that produced this finding; the change is low-risk either way.";
	rec.confidence = "high";
	rec.calc_method = size !== null && cur !== null
		? `${size}GB × ($${money(gp2rate)} − $${money(gp3rate)})/GB-mo = ${usd(round2(size * (gp2rate - gp3rate)))}/mo (measured ${usd(cur)}/mo → ${usd(proj)}/mo)`
		: `Published rate drop: $${money(gp2rate)} → $${money(gp3rate)} per GB-month (≈20%)`;
	rec.risks = [
		rds ? "Verify gp3 allocated IOPS/throughput covers the DB's p99 load at switch time." : "gp3 baseline is 3,000 IOPS / 125 MB/s — re-provision if the volume used more.",
	];
	rec.data_gaps = [
		"Exact per-GB prices vary slightly by region — the arithmetic uses the published ap-south-1 rates.",
	];
	return finish(rec, f, "low", "Cost computed from published per-GB rates on the measured size; deterministic, no estimates.");
}

function eipRec(f: Finding, cur: number | null): RecDetail {
	const rec = baseRec(f, cur);
	rec.issue = "Elastic IP not associated with any running instance — billed hourly with or without traffic.";
	rec.options = [
		{
			title: "Release the address",
			change: "EC2 console → Elastic IPs → Release this address",
			saving_mo: cur ?? round2(EIP_HOURLY * 730),
			trade_off: "Re-acquiring the same IP later is not guaranteed (most apps should use DNS anyway).",
		},
	];
	rec.selected = 0;
	rec.change = rec.options[0].change;
	rec.projected_cost_mo = 0;
	rec.saving_mo = rec.options[0].saving_mo;
	rec.why_selected = "Idle EIPs bill $0.005/hr with zero benefit; releasing is instant and free.";
	rec.confidence = "high";
	rec.calc_method = `$${EIP_HOURLY}/hr × 730h = ${usd(round2(EIP_HOURLY * 730))}/mo removed entirely on release`;
	rec.risks = ["An app hard-coding this IP would break — grep configs/limits or use a DNS name before releasing."];
	return finish(rec, f, "low", "EIP idle rate is a fixed published price.");
}

function snapshotRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const size = num(m.size_gb);
	const isLarge = f.category.startsWith("Review");
	rec.issue = isLarge
		? "Old, unlinked, large snapshot — of no AMI dependency yet still billed monthly."
		: "Old unlinked snapshot: no AMI references it, and its age suggests it was retained by accident.";
	rec.options = [
		{
			title: "Delete + enforce DLM retention",
			change: `Delete this snapshot, then apply a Data Lifecycle Manager policy (30–90d auto-expiry) to the whole set`,
			saving_mo: size !== null ? round2(size * SNAP_GB_MO) : cur,
			trade_off: "Snapshots are just deleted data at $0.05/GB-mo — DLM policy prevents the recurrence.",
		},
		{ title: "Delete only this one", change: "Delete the snapshot now (no policy change)", saving_mo: null, trade_off: "Fast, but the same snapshot reappears next quarter." },
	];
	rec.selected = 0;
	rec.change = rec.options[0].change;
	rec.projected_cost_mo = 0;
	rec.saving_mo = rec.options[0].saving_mo;
	rec.why_selected = "Deleting captures today's saving and the DLM policy stops the pattern that created it — a strictly better outcome than the one-off delete.";
	rec.confidence = "high";
	rec.calc_method = size !== null
		? `${size}GB × $${SNAP_GB_MO}/GB-mo = ${usd(round2(size * SNAP_GB_MO))}/mo reduced to $0 on delete`
		: "Snapshot rate $0.05/GB-mo";
	rec.risks = [
		"Compliance regimes sometimes mandate keeping specific snapshots — verify policy first.",
	];
	return finish(rec, f, "low", "ami_linked = false observed directly in the describe call; cost = published rate × measured size.");
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
	rec.issue = `Instance class ${cls} is far larger than its steady load (CPU ${m.cpu_avg ?? "?"}%, conns ${m.conns_avg ?? "?"}).`;
	rec.options = [];
	if (d1) rec.options.push({
		title: "Downsize one step",
		change: `${cls} → ${d1.type}${maz ? " (MultiAZ stays on — both AZs resized)" : ""}`,
		saving_mo: p1 !== null && cur !== null ? round2(Math.max(0, cur - p1)) : null,
		trade_off: "Reboot inside the maintenance window; MultiAZ failover makes it brief.",
	});
	if (d3) rec.options.push({
		title: "Downsize deeper (3 steps)",
		change: `${cls} → ${d3.type}`,
		saving_mo: p3 !== null && cur !== null ? round2(Math.max(0, cur - p3)) : null,
		trade_off: "Deeper cut — needs a 30-day low-usage record and max_connections headroom check.",
	});
	if (maz || Number(m.cpu_avg) < 10) rec.options.push({
		title: "Aurora Serverless v2 switch",
		change: "Migrate to Aurora Serverless v2 (same engine) — capacity auto-scales in 0.5 ACU steps to actual load",
		saving_mo: cur !== null ? round2(cur * 0.7) : null,
		trade_off: "Bigger migration (data copy + cutover); ends the pay-for-peak model for spiky workloads.",
	});
	pickBest(rec, cur);
	rec.why_selected = rec.options[rec.selected] !== undefined
		? `${rec.options[rec.selected].title} yields the biggest measured saving (${usd(rec.options[rec.selected].saving_mo)}/mo of ${usd(cur)}/mo) against the observed CPU/connection profile.`
		: "";
	rec.confidence = m.cpu_avg != null && m.conns_avg != null ? "medium" : "low";
	rec.risks = [
		"The resize triggers a reboot in the maintenance window.",
		"max_connections shrinks with the class — verify it still covers the app pool plus autoscale.",
	];
	rec.data_gaps = [
		"Memory is not directly measured (no Performance Insights taken) — a 24h Insights check removes doubt before the resize.",
	];
	if (cur === null) rec.data_gaps.push("Instance price unknown in this window.");
	return finish(rec, f, "medium", `Measured CPU ${m.cpu_avg ?? "?"}% / conns ${m.conns_avg ?? "?"} over the window${p1 !== null ? "; target price derived from family-linear pricing" : ""}.`);
}

function rdsStoppedRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const storageGb = num(m.storage_gb);
	const keepCost = storageGb !== null ? round2(storageGb * 0.095) : null;
	rec.issue = "Stopped RDS instance: compute is paused but storage + automated backups keep billing — and RDS auto-restarts instances stopped more than 7 days, so stop-based savings are unreliable.";
	rec.options = [
		{
			title: "Final snapshot then delete",
			change: `Take a final snapshot and delete the ${m.engine ?? "DB"} instance${storageGb !== null ? ` (${storageGb}GB storage)` : ""}`,
			saving_mo: cur,
			trade_off: `Snapshot retention (~${usd(keepCost)}/mo) replaces the running cost until expired.`,
		},
		{ title: "Keep stopped", change: "Leave stopped for a planned return (storage keeps billing; auto-restart kicks in at 7 days)", saving_mo: null, trade_off: "Only sensible for a short, deliberate pause." },
	];
	rec.selected = 0;
	rec.change = rec.options[0].change;
	rec.projected_cost_mo = keepCost;
	rec.saving_mo = cur;
	rec.why_selected = "A stopped instance still earns nothing: the snapshot option stops compute + instance-class charges while keeping the data at snapshot rate.";
	rec.confidence = "high";
	rec.calc_method = cur !== null
		? `Measured running cost ${usd(cur)}/mo → snapshot-only ${usd(keepCost)}/mo ⇒ ${usd(keepCost !== null ? round2(cur - keepCost) : cur)}/mo`
		: "Running cost from the price table; snapshot at $0.095/GB-mo";
	rec.risks = [
		"Some jobs reference the DB by name or a startup script that will break after deletion.",
		"Search parameter group, option group, and network context — a restore needs them re-set.",
	];
	if (keepCost !== null) rec.data_gaps.push(`Remaining snapshot/storage cost (~${usd(keepCost)}/mo) is NOT subtracted from the headline saving.`);
	return finish(rec, f, "medium", `Status '${m.state ?? "stopped"}' confirmed from describe; class + storage from the same call.`);
}

// ── Network / load balancing / EKS / secrets / CW / S3 handlers ─────────────

function elbRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const reqs = num(m.requests);
	const isNoTargets = f.category.includes("No healthy targets");
	const base24 = round2(0.0225 * 730); // typical ALB hourly base
	rec.issue = isNoTargets
		? `Load balancer has ${m.healthy ?? 0} healthy / ${m.unhealthy ?? "?"} unhealthy targets — it is billed (base + LCU) while serving no traffic.`
		: `Near-zero traffic LB (${reqs ?? "n/a"} requests over the window) — paying the fixed base plus LCU for nothing.`;
	rec.options = [
		{
			title: isNoTargets ? "Delete the load balancer" : "Delete after consolidating listeners",
			change: isNoTargets
				? `Delete ${String(m.type ?? "ALB")} and its target groups (fix targets first if the service should exist)`
				: "Move listeners onto an active ALB via listener rules (host/path), then delete this one",
			saving_mo: cur ?? base24,
			trade_off: "DNS records pointing at this LB must be re-pointed or allowed to lapse.",
		},
		{
			title: "Fix target health instead",
			change: isNoTargets ? "Repair the registered targets (their health check path/port/SG) and keep the LB in service" : "",
			saving_mo: null,
			trade_off: "Only right if the service behind it is genuinely needed — that is a product decision.",
		},
	];
	pickBest(rec, cur);
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = 0;
	rec.saving_mo = cur ?? base24;
	rec.why_selected = "Both the base charge and LCU charges disappear the moment the LB is deleted; there is no lighter-weight variant with a lower fixed cost.";
	rec.confidence = cur !== null ? "high" : "medium";
	rec.calc_method = cur !== null
		? `Measured bill ${usd(cur)}/mo → $0 after deletion (any dependent DNS/records excluded)`
		: `ALB base $0.0225/hr × 730h ≈ ${usd(base24)}/mo plus LCU charges`;
	rec.risks = [
		"Anything still sending requests here breaks when the LB disappears — the near-zero traffic must be accounted for first.",
	];
	if (cur === null) rec.data_gaps.push("LCU charges not measured in this scan — total bill is base + LCU.");
	return finish(rec, f, "medium", `LB state: ${m.healthy ?? "?"} healthy / ${m.unhealthy ?? "?"} unhealthy targets, ${reqs ?? "n/a"} requests measured over the window.`);
}

function natRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const outGb = num(m.out_gb) ?? 0;
	const dataProcMo = round2(outGb * NAT_HOURLY); // out_gb is already window-aggregated GB
	const baseMo = round2(NAT_HOURLY * 730);
	const idle = f.category.startsWith("Idle");
	rec.issue = idle
		? `NAT gateway processes almost no traffic (${outGb}GB out per window) — the fixed $${NAT_HOURLY}/hr dominates the bill.`
		: `Low-traffic NAT — the fixed hourly base dominates its cost at this volume.`;
	rec.options = idle ?
		[
			{
				title: "Delete the NAT gateway",
				change: "VPC console → NAT gateways → delete, then remove the private route-table route that points at it",
				saving_mo: round2(baseMo + dataProcMo),
				trade_off: "Any private subnet still routed through it loses internet egress — check route tables first.",
			},
			{
				title: "Replace with VPC endpoints",
				change: "Add S3 + DynamoDB gateway endpoints (free) or interface endpoints ($0.01/hr per AZ) for only the S3/DDB traffic, then delete the NAT",
				saving_mo: round2(baseMo * 0.75 + dataProcMo),
				trade_off: "Keeps private access for AWS services; general internet egress still needs a NAT elsewhere.",
			},
		] :
		[
			{
				title: "Consolidate single-AZ",
				change: "Drop one of two NATs if its AZ carries minimal traffic and cross-AZ resilience can be relaxed there",
				saving_mo: round2(baseMo + dataProcMo * 0.5),
				trade_off: "Reduces AZ fault-tolerance for outbound traffic in that subnet group.",
			},
			{
				title: "Add S3/DynamoDB VPC endpoints",
				change: "Gateway endpoints for S3+DynamoDB (free) — their traffic stops flowing through the NAT",
				saving_mo: round2(outGb * NAT_HOURLY * 0.6),
				trade_off: "Zero cost; narrows the NAT's per-GB bill to genuinely non-AWS destinations.",
			},
		];
	pickBest(rec, cur);
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = cur !== null && rec.saving_mo !== null ? round2(Math.max(0, cur - rec.saving_mo)) : null;
	rec.why_selected = rec.options[rec.selected].title === "Replace with VPC endpoints"
		? "Gateway endpoints are free, preserve private AWS access, and the NAT base charge also disappears."
		: "The fixed hourly base is the dominant, unavoidable charge while the NAT exists — removing it is the only way to stop it.";
	rec.confidence = "high";
	rec.calc_method = cur !== null
		? `Measured window bill ${usd(cur)}/mo → $0 (or ${usd(rec.projected_cost_mo)} with endpoints) after the change; per-GB processing of out ${outGb}GB included`
		: `NAT base $${NAT_HOURLY}/hr × 730h = ${usd(baseMo)}/mo + per-GB data processing on measured ${outGb}GB`;
	rec.risks = [
		"Deleting the NAT does not automatically delete its Elastic IP — release it separately to avoid stray $3.65/mo EIP charges.",
		"Private subnets in dependent route tables can silently lose egress.",
	];
	return finish(rec, f, "medium", `NAT bytes-out ${outGb}GB measured over the window; base rate $${NAT_HOURLY}/hr is published.`);
}

function eksRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const noNg = f.category.includes("No nodegroups");
	const oldV = f.category.includes("Old K8s");
	if (noNg) {
		const baseMo = round2(EKS_CLUSTER_HOURLY * 730);
		rec.issue = "EKS cluster with no nodegroups or workloads — still paying the control-plane hourly rate.";
		rec.options = [
			{ title: "Delete the cluster", change: "EKS console → delete cluster + its leftover ELBs/volumes/ENIs", saving_mo: cur ?? baseMo, trade_off: "Rebuilding a cluster later is easy (eksctl/IaC) but configs/state are lost." },
			{ title: "Keep control plane only", change: "If workloads return soon, keep the control plane and add Fargate profiles when needed", saving_mo: null, trade_off: "The $73/mo control-plane bill continues meanwhile." },
		];
		rec.selected = 0; rec.change = rec.options[0].change;
		rec.saving_mo = cur ?? baseMo; rec.projected_cost_mo = 0;
		rec.why_selected = "An idle control plane produces nothing; clearing and rebuilding from IaC when needed is cheaper than parking it.";
		rec.confidence = cur !== null ? "high" : "medium";
		rec.calc_method = cur !== null ? `Measured ${usd(cur)}/mo → $0 on delete` : `Control plane $${EKS_CLUSTER_HOURLY}/hr × 730h = ${usd(baseMo)}/mo`;
		rec.risks = ["Check for leftover ALBs/volumes in the cluster's VPC — delete them too, or the bill only partially drops."];
		rec.data_gaps = ["The cluster's true bill includes any leftover worker instance hours — none were found in this scan."];
		return finish(rec, f, "medium", `No managed nodegroups found via describe_nodegroups; control-plane rate published at $${EKS_CLUSTER_HOURLY}/hr.`);
	}
	if (oldV) {
		rec.issue = "Cluster is on an EOL Kubernetes version — extended-support surcharge applies once past the 14-month window.";
		rec.options = [
			{ title: "In-place upgrade to 1.28+", change: "Bump control-plane version, then update each nodegroup AMI", saving_mo: null, trade_off: "Extends support-fee exposure; requires pod-disruption scheduling." },
			{ title: "Upgrade + demote to Fargate Spot", change: "Upgrade version AND move non-critical workloads to Fargate Spot (~70% cheaper per pod)", saving_mo: null, trade_off: "Spot pods can be evicted with 2min notice." },
		];
		rec.selected = 1; rec.change = rec.options[1].change;
		rec.saving_mo = cur; rec.projected_cost_mo = cur !== null ? round2(Math.max(0, cur - (rec.saving_mo ?? 0))) : null;
		rec.why_selected = "The upgrade removes the surcharge moving forward while Fargate Spot cuts the underlying compute bill — two saving layers in one change.";
		rec.confidence = "medium"; rec.data_gaps = ["Extended-support rate depends on the exact EOL phase and region; the headline figure is the conservative rule-of-thumb."];
		rec.risks = ["Version jump must follow the deprecation ledger of removed APIs (check on your manifests)."];
		return finish(rec, f, "medium", `Cluster version scanned at v${String(m.version ?? "?")}, published extended-support rate is $0.50/hr over standard.`);
	}
	rec.issue = "Nodegroup is provisioned far larger than workload demand (sizable idle instance-hours vs actual usage).";
	// Derive the compute bill from the declared nodegroup shape + published price.
	const types = Array.isArray(m.instance_types) ? m.instance_types : [];
	const nodes = num(m.desired_size) ?? 1;
	const nodeType = typeof types[0] === "string" ? types[0] : null;
	const nodePrice = nodeType ? ec2PriceOf(nodeType) : null;
	const derived = nodePrice !== null ? round2(nodes * nodePrice) : null;
	const curBill = cur ?? derived;
	if (curBill !== null) rec.current_cost_mo = curBill;
	rec.options = [
		{ title: "Karpenter + consolidation", change: "Deploy Karpenter with bin-packing consolidation and a right-sized instance set", saving_mo: curBill !== null ? round2(curBill * 0.7) : null, trade_off: "New controller dependency — needs its own ops care." },
		{ title: "Spot for stateless", change: "Move stateless deployments to Spot (or Fargate Spot) with graceful-drain PDBs", saving_mo: curBill !== null ? round2(curBill * 0.6) : null, trade_off: "Spot interruptions require resume-tolerant design." },
	];
	rec.selected = 0; rec.change = rec.options[0].change;
	rec.saving_mo = rec.options[0].saving_mo;
	rec.projected_cost_mo = curBill !== null ? round2(Math.max(0, curBill - (rec.saving_mo ?? 0))) : null;
	rec.why_selected = "Karpenter's bin-packing + right-sizing captures the widest set of savings and subsumes Spot-on-stateless later.";
	rec.confidence = curBill !== null ? "low" : "low";
	rec.data_gaps = nodePrice !== null
		? [`The waste share is unknown in this scan — the bill is derived from the declared nodegroup (${nodes} × ${nodeType} at ${usd(nodePrice)}/mo = ${usd(curBill)}/mo) and a conservative 70% consolidation saving; measure per-pod requests first.`]
		: ["The nodegroup's bill and its waste share are both unknown in this scan; treat any estimate as an upper bound."];
	rec.risks = ["Old AMIs incompatible with Karpenter need refresh; any PodDisruptionBudget must be reviewed before eviction waves."];
	return finish(rec, f, "medium", `Nodegroup shape from the API: ${nodes} nodes × ${nodeType ?? "?"} at ${usd(nodePrice ?? null)}/mo.`);
}

function secretRec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	rec.issue = "Secret not accessed in 90+ days — the fixed per-secret price accrues with no consumer.";
	rec.options = [
		{ title: "Delete (recoverable)", change: "Delete the secret — it stays recoverable 7–30 days, giving stray consumers time to flag", saving_mo: cur ?? 0.4, trade_off: "If a forgotten app reads it, the recovery window is the warning period; after that, gone." },
		{ title: "Consolidate", change: "Merge several single-field secrets into one structured secret", saving_mo: null, trade_off: "Drops the per-secret price for the redundant copies." },
	];
	rec.selected = 0; rec.change = rec.options[0].change;
	rec.projected_cost_mo = 0; rec.saving_mo = rec.options[0].saving_mo;
	rec.why_selected = "A dead secret is pure liability (security + cost); the deletion recovery window makes the move reversible.";
	rec.confidence = "high";
	rec.calc_method = "$0.40/secret/mo is the published per-secret rate — deleted secret brings it to $0";
	rec.risks = [
		"CloudTrail GetSecretValue could be missing third-party reads if the audit role lacks CloudTrail scope.",
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
		? `High daily ingestion (${ingestD}GB/day) — retention is fine but the ingestion itself dominates.`
		: "Log group never expires — stored logs accumulate indefinitely at the storage rate.";
	const isHigh = f.category.includes("High ingestion");
	if (isHigh) {
		rec.options = [
			{ title: "Sample + metric-filters", change: "Cut DEBUG at source libraries and emit CloudWatch metric filters instead of full log lines", saving_mo: ingestMo ?? cur, trade_off: "You keep visibility via metrics but lose per-event detail for the sampled classes." },
			{ title: "Export to S3 + retain 7d in CW", change: "Ship full logs to S3 (much cheaper retention chain) and cap the CloudWatch copy at 7d", saving_mo: ingestMo !== null ? round2(ingestMo * 0.3) : null, trade_off: "Search moves from CloudWatch Insights to Athena/Glacier queries." },
		];
	} else {
		rec.options = [
			{ title: "Set retention 30–90d", change: "Logs console → per-group retention policy → 30–90d (operational groups 30d, security 90d+)", saving_mo: cur, trade_off: "Older logs become unrecoverable after expiry — export what must live on to S3 first." },
			{ title: "Retention + DEBUG cut", change: "Same retention, plus cut DEBUG at source to shrink ingest too", saving_mo: null, trade_off: "Smaller ingest lowers the per-GB ingestion line as well." },
		];
	}
	pickBest(rec, cur);
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = rec.selected === 0 && !isHigh && ingestMo !== null
		? round2(Math.min(ingestMo, ingestD * 30 * CW_STORE_GB_MO)) // capped at 30 days of stored ingest
		: null;
	rec.why_selected = isHigh
		? "Ingestion $0.50/GB is the dominant price and only source-level verbosity cuts it; export alone does not remove that line item."
		: "The storage cost only stops accumulating when a concrete retention bound expires old data — this is a one-change fix.";
	rec.confidence = "medium";
	rec.calc_method = isHigh
		? `${ingestD}GB/day × $${CW_INGEST_GB}/GB ⇒ ${usd(ingestMo)}/mo ingest; source-level sampling cuts the bulk of that`
		: `${storedGb}GB stored × $${CW_STORE_GB_MO}/GB-mo ⇒ ${usd(cur)}/mo; retention 30d caps stored volume at the last 30 days of ingest`;
	rec.risks = [
		"Expiring logs too early erases forensic history — stage a 90d S3 export before applying the 30d retention.",
	];
	return finish(rec, f, "low", `Ingest ${ingestD}GB/day, stored ${storedGb}GB from CloudWatch ListMetrics; rates $${CW_INGEST_GB} ingest / $${CW_STORE_GB_MO} storage per GB published.`);
}

function s3Rec(f: Finding, cur: number | null): RecDetail {
	const m = f.meta ?? {};
	const rec = baseRec(f, cur);
	const sizeGb = num(m.size_gb) ?? 0;
	const isIdle = f.category.includes("Near-empty");
	const isVersioned = f.category.includes("Versioned");
	const objects = num(m.objects);
	if (isIdle) {
		rec.issue = "Bucket holds almost nothing and sees no requests — cost is small but a hygiene signal for the account-wide picture.";
		rec.options = [
			{ title: "Delete the bucket", change: "Confirm no app/IaC references the name, then empty and delete", saving_mo: cur ?? 0, trade_off: "Keeps the S3 namespace clean for buckets that matter." },
			{ title: "Keep + 7d expiry", change: "Apply a 7d object-expiry lifecycle to prove it stays unused, then delete", saving_mo: null, trade_off: "Cheap insurance against a consumer appearing." },
		];
		rec.selected = 0; rec.change = rec.options[0].change;
		rec.saving_mo = cur ?? 0; rec.projected_cost_mo = 0;
		rec.why_selected = "At near-zero size, deletion is safe and the request/storage cost was already ~0 — this is hygiene, not dollars.";
		rec.confidence = "high";
		rec.calc_method = `Measured ${sizeGb}GB / ${objects ?? "?"} objects → $${money(cur ?? 0)}/mo → $0 on delete`;
		rec.risks = ["References in code/IaC must be checked before removal."];
		return finish(rec, f, "low", `Bucket inventory (ListObjectsV2 + GetBucketLifecycle) reported ${sizeGb}GB / ${objects ?? "?"} objects, no lifecycle rule.`);
	}
	if (isVersioned) {
		const head = sizeGb !== null ? round2(Math.min(sizeGb * 0.4, 100)) : cur;
		rec.issue = "Versioning is enabled with no noncurrent-version expiry — every overwritten copy bills forever.";
		rec.options = [
			{ title: "Expire noncurrent versions", change: "Lifecycle rule: delete noncurrent versions after 30–90d + abort incomplete multipart uploads after 7d", saving_mo: cur ?? head, trade_off: "Choose the days by your restore-drill needs." },
		];
		rec.selected = 0; rec.change = rec.options[0].change;
		rec.saving_mo = rec.options[0].saving_mo; rec.projected_cost_mo = null;
		rec.why_selected = "Noncurrent versions are pure duplication of data that already exists in the current ones.";
		rec.confidence = "medium";
		rec.calc_method = cur !== null
			? `Measured bill ${usd(cur)}/mo; roughly 40% of versioning overhead is redundant history (capped heuristic)`
			: "Noncurrent share unknown — requires listing noncurrent versions";
		rec.risks = ["Aggressive day-counts erase your restore points; match to backup policy."];
		rec.data_gaps = ["Per-object access stats not collected — refine the retention window after one month of access logs."];
		return finish(rec, f, "low", " bucket listing showed versioning enabled with no lifecycle rule present.");
	}
	// No lifecycle policy
	const scanSaving = round2(Math.min(sizeGb * 0.01, 200));
	rec.issue = "No lifecycle policy: objects bill Standard rate forever, even the cold ones.";
	rec.options = [
		{
			title: "Lifecycle rules (predictable)",
			change: "Expire noncurrent 30–90d; Standard→Standard-IA at 30d → Glacier regular at 90d; abort multipart 7d",
			saving_mo: scanSaving,
			trade_off: "Retrieval fees + wait times for Glacier when data is requested again.",
		},
		{
			title: "Intelligent-Tiering",
			change: `Apply Intelligent-Tiering${objects !== null && objects < 500000 ? "" : " (8-tier auto-deciders)"}`,
			saving_mo: round2(Math.min(sizeGb * 0.008, 200)),
			trade_off: "No retrieval fees, zero lifecycle tuning — costs a small monitoring fee per object (>128KB).",
		},
	];
	rec.selected = objects !== null && objects > 1000000 ? 1 : 0;
	rec.change = rec.options[rec.selected].change;
	rec.projected_cost_mo = cur !== null && rec.saving_mo !== null ? round2(Math.max(0, cur - rec.saving_mo)) : null;
	rec.why_selected = rec.selected === 1
		? "With millions of objects and unknown access patterns, Intelligent-Tiering's automatic tier-shift beats hand-tuned transitions that risk retrieval fees."
		: "Lifecycle rules with 30/90d transitions price cheaper than Intelligent-Tiering at this object count and produce predictable archive dates.";
	rec.confidence = "medium";
	rec.calc_method = cur !== null
		? `Measured ${usd(cur)}/mo Standard ⇒ ${usd(rec.projected_cost_mo)}/mo after tier shift; scan estimate assumed ~35% data going cold`
		: `${sizeGb}GB × Standard $0.023/GB ⇒ ${usd(round2(sizeGb * 0.023))}/mo today`;
	rec.risks = [
		"Glacier retrievals cost per-GB and take minutes — guarantee nothing business-critical goes there without a plan.",
	];
	rec.data_gaps = [
		"No per-object access statistics available: the cold-share estimate (~35%) is a heuristic — refine after 30d of access logs.",
	];
	return finish(rec, f, "medium", `Bucket metrics: ${sizeGb}GB / ${objects ?? "?"} objects, lifecycle absent (verified via GetBucketLifecycle), ${usd(cur)}/mo measured storage cost.`);
}

function vpnRec(f: Finding, cur: number | null): RecDetail {
	const rec = baseRec(f, cur);
	rec.issue = "Site-to-Site VPN attached with near-zero traffic — the $0.05/hr constant charges regardless.";
	rec.options = [
		{ title: "Delete the VPN connection + CGW", change: "VPC console → Site-to-Site VPN → delete connection and Customer Gateways", saving_mo: cur ?? round2(0.05 * 730), trade_off: "Re-establishing needs partner coordination (public IP + BGP setup)." },
	];
	rec.selected = 0; rec.change = rec.options[0].change;
	rec.projected_cost_mo = 0; rec.saving_mo = rec.options[0].saving_mo;
	rec.why_selected = "Idle VPNs bill $0.05/hr = ~$36.5/mo for a tunnel carrying nothing.";
	rec.confidence = "high";
	rec.calc_method = `$0.05/hr × 730h = ${usd(round2(0.05 * 730))}/mo removed on deletion`;
	rec.risks = ["If the far side ever needs the tunnel back, re-establishing requires their network ops team."];
	return finish(rec, f, "low", "VPN hourly rate is published; near-zero traffic confirmed in the scan.");
}

function genericRec(f: Finding, cur: number | null): RecDetail {
	const rec = baseRec(f, cur);
	rec.issue = f.category.replace(/^[^—]+—\s*/, "") + " detected on this resource.";
	rec.options = [
		{ title: "Apply the finding's recommended action", change: f.recommendation, saving_mo: num(f.est_monthly_saving_usd) ?? 0, trade_off: "Verify resource ownership before acting." },
	];
	rec.selected = 0;
	rec.change = f.recommendation;
	rec.saving_mo = num(f.est_monthly_saving_usd) ?? 0;
	rec.projected_cost_mo = cur !== null ? round2(Math.max(0, cur - (rec.saving_mo ?? 0))) : null;
	rec.why_selected = "Single best available action for this finding type; resource-specific refinement needs the scanner's deeper metrics.";
	rec.confidence = "medium";
	rec.data_gaps = ["This finding type is not fully modelled yet — the numbers rely on the scan's rule-of-thumb."];
	rec.risks = ["Check ownership and dependencies before acting."];
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
