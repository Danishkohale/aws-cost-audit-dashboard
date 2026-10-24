/**
 * The audit step registry — the single source of truth shared by
 *  * `runAwsAudit()` (whole-account, unbounded), and
 *  * `POST /api/collect/:step` (bounded, browser-driven fan-out).
 *
 * Order and `progress` values mirror `audit_runner.py:61-172` so the progress bar
 * behaves exactly as it did in the Python app: base scans walk 18→95, then the
 * deep layer finishes at 96/97 before the job hits 100.
 */
import type { Finding } from "../types";
import type { Aws } from "../aws/clients";
import type { ScanRange, ScanResult } from "../aws/range";
import { auditCloudwatch } from "../aws/services/cloudwatch";
import { auditEc2 } from "../aws/services/ec2";
import { auditEc2Other } from "../aws/services/ec2-other";
import { auditEks } from "../aws/services/eks";
import { auditElb } from "../aws/services/elb";
import { auditRds } from "../aws/services/rds";
import { auditS3 } from "../aws/services/s3";
import { auditSecrets } from "../aws/services/secrets";
import { auditVpc } from "../aws/services/vpc";
import { detailCloudwatch } from "../aws/detail/cloudwatch";
import { detailEbs } from "../aws/detail/ebs";
import { detailEc2 } from "../aws/detail/ec2";
import { detailElb } from "../aws/detail/elb";
import { detailRds } from "../aws/detail/rds";
import { detailS3 } from "../aws/detail/s3";
import { detailSnapshots } from "../aws/detail/snapshots";
import { detailVpc } from "../aws/detail/vpc";

export type StepPhase = "base" | "detail";

export interface StepDef {
	/** Stable id used by `POST /api/collect/:step`. */
	name: string;
	label: string;
	phase: StepPhase;
	/** Progress percentage recorded when the step finishes. */
	progress: number;
	/**
	 * How many resources to process per call. Chosen so that the worst case
	 * subrequest count for one call stays well under the Free plan's limit of 50.
	 */
	chunk: number;
	run: (aws: Aws, findings: Finding[], days: number, range?: ScanRange) => Promise<ScanResult>;
}

/** Cost Explorer is a single call, so it is tracked separately. */
export const COST_STEP = "cost";
export const COST_PROGRESS = 18;

export const BASE_STEPS: StepDef[] = [
	{ name: "ec2", label: "EC2 instances", phase: "base", progress: 26, chunk: 25, run: auditEc2 },
	{
		name: "ec2-other",
		label: "EC2-Other (EBS/EIP/snapshots)",
		phase: "base",
		progress: 38,
		chunk: 50,
		run: auditEc2Other,
	},
	{ name: "rds", label: "RDS", phase: "base", progress: 50, chunk: 20, run: auditRds },
	{ name: "elb", label: "ELB", phase: "base", progress: 60, chunk: 8, run: auditElb },
	{ name: "vpc", label: "VPC (NAT/VPN)", phase: "base", progress: 70, chunk: 20, run: auditVpc },
	{ name: "eks", label: "EKS", phase: "base", progress: 78, chunk: 5, run: auditEks },
	{
		name: "secrets",
		label: "Secrets Manager",
		phase: "base",
		progress: 84,
		chunk: 30,
		run: auditSecrets,
	},
	{
		name: "cloudwatch",
		label: "CloudWatch",
		phase: "base",
		progress: 90,
		chunk: 200,
		run: auditCloudwatch,
	},
	{ name: "s3", label: "S3", phase: "base", progress: 95, chunk: 12, run: auditS3 },
];

/** Deep layer — Python logs 96 for the batch and 97 once it completes. */
export const DETAIL_STEPS: StepDef[] = [
	{
		name: "ec2-detail",
		label: "EC2 detail",
		phase: "detail",
		progress: 96,
		chunk: 8,
		run: detailEc2,
	},
	{
		name: "ebs-detail",
		label: "EBS detail",
		phase: "detail",
		progress: 96,
		chunk: 12,
		run: detailEbs,
	},
	{
		name: "snapshot-detail",
		label: "Snapshot detail",
		phase: "detail",
		progress: 96,
		chunk: Number.POSITIVE_INFINITY,
		run: detailSnapshots,
	},
	{
		name: "rds-detail",
		label: "RDS detail",
		phase: "detail",
		progress: 96,
		chunk: 6,
		run: detailRds,
	},
	{ name: "s3-detail", label: "S3 detail", phase: "detail", progress: 96, chunk: 6, run: detailS3 },
	{
		name: "cloudwatch-detail",
		label: "CloudWatch detail",
		phase: "detail",
		progress: 96,
		chunk: 18,
		run: detailCloudwatch,
	},
	{
		name: "vpc-detail",
		label: "VPC detail",
		phase: "detail",
		progress: 96,
		chunk: 15,
		run: detailVpc,
	},
	{
		name: "elb-detail",
		label: "ELB detail",
		phase: "detail",
		progress: 97,
		chunk: 6,
		run: detailElb,
	},
];

export const SCAN_STEPS: StepDef[] = [...BASE_STEPS, ...DETAIL_STEPS];

/** Every step id the client may POST, in order, including `cost`. */
export const STEP_NAMES: string[] = [COST_STEP, ...SCAN_STEPS.map((s) => s.name)];

/** The final step — completing it finalizes the job. */
export const LAST_STEP: string = SCAN_STEPS[SCAN_STEPS.length - 1].name;

export function stepDef(name: string): StepDef | undefined {
	return SCAN_STEPS.find((s) => s.name === name);
}

/** Progress to record once `name` completes. */
export function progressFor(name: string): number {
	if (name === COST_STEP) return COST_PROGRESS;
	return stepDef(name)?.progress ?? 99;
}
