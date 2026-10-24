/**
 * Audit orchestration — port of `audit_runner.py:61-172` `run_audit_job()`.
 *
 * This entry point runs **every** step in one shot (unbounded), which is what the
 * Phase 2 parity tests exercise. The production path is the chunked fan-out in
 * `src/collect/` + `POST /api/collect/:step`, which shares the same registry.
 */
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { Finding, Payload } from "../types";
import type { Aws } from "./clients";
import { BASE_STEPS, DETAIL_STEPS } from "../collect/registry";
import { auditLiveCost } from "./cost-explorer";
import { maskKey } from "./guard";
import { errMsg } from "./util";
import { todayIso } from "../report/format";

export type AuditLog = (msg: string, progress?: number) => void;

export async function checkIdentity(aws: Aws, log: AuditLog): Promise<void> {
	try {
		const ident = await aws.sts.send(new GetCallerIdentityCommand({}));
		log(`[auth] OK: ${ident.Arn ?? "None"}`, 8);
	} catch (e) {
		log(`[auth] STS check failed (continuing read-only): ${errMsg(e)}`, 8);
	}
}

export interface AuditOptions {
	days: number;
	log: AuditLog;
	/** Only used to produce the masked auth log line. */
	accessKeyId?: string | null;
}

export async function runAwsAudit(aws: Aws, opts: AuditOptions): Promise<Payload> {
	const { days, log, accessKeyId } = opts;

	log(`[auth] Using explicit keys (${maskKey(accessKeyId)}) in ${aws.region} — in-memory only.`, 5);
	await checkIdentity(aws, log);

	const findings: Finding[] = [];
	log(
		`Scanning ${aws.region} (EC2/RDS/EC2-Other/ELB/VPC/EKS/Secrets/CW/S3, QuickSight skipped)…`,
		10,
	);

	const { cost, note } = await auditLiveCost(aws.ce);
	log(`[cost] ${note}`, 18);

	for (const [label, pct, fn] of BASE_LOOPS) {
		try {
			log(`[${label}] scanning…`);
			await fn(aws, findings, days);
			log(`[${label}] done.`, pct);
		} catch (e) {
			log(`[warn] ${label} step failed: ${errMsg(e)}`, pct);
		}
	}

	log("[detail] Per-resource deep scan (S3/EC2/EBS/snapshots/RDS/CW/VPC/ELB)…", 96);
	const before = findings.length;
	for (const step of DETAIL_STEPS) {
		try {
			log(`[detail] ${step.label}…`);
			await step.run(aws, findings, days);
		} catch (e) {
			log(`[warn] ${step.label} failed: ${errMsg(e)}`);
		}
	}
	const added = findings.length - before;
	log(`[detail] done (+${added} detailed rows).`, 97);

	return {
		date: todayIso(),
		region: aws.region,
		lookback_days: days,
		live_cost_by_service: cost,
		cost_note: note,
		findings,
	};
}

const BASE_LOOPS: [string, number, (a: Aws, f: Finding[], d: number) => Promise<unknown>][] =
	BASE_STEPS.map((s) => [s.label, s.progress, (a: Aws, f: Finding[], d: number) => s.run(a, f, d)]);
