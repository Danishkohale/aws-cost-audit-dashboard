/**
 * Fixed phrasing — the static vocabulary used by the audit engine and reports.
 *
 * All report text is templated with interpolated values; nothing is generated
 * dynamically. These strings are the product and must stay verbatim with the
 * Python source (cost-optimization.py / detailed_audit.py / write_html / write_docx).
 */

export const REPORT_TITLE = "AWS Cost Optimization Audit — Idle & Waste";

export const DOC_HEADING_LIVE_COST = "1. Live Cost by Service";
export const DOC_HEADING_FINDINGS = "2. Idle / Waste Findings";
export const DOC_HEADING_PLAN = "3. Prioritized Savings Plan";

/** Fixed table fallbacks (write_html). */
export const NO_FINDINGS_ROW =
	"<tr><td colspan=6>No idle/waste found — well optimized for scanned scope.</td></tr>";
export const NO_COST_ROW = "<tr><td colspan=2>Cost Explorer unavailable — see note.</td></tr>";

/** "Top savings levers" card in the HTML report (write_html). */
export const SAVINGS_LEVERS_HTML =
	"<b>Top savings levers:</b> 1) EC2 rightsizing + schedules + Savings Plans 2) RDS downsizing + RI + autoscaling 3) Delete unattached EBS/EIP/snapshots 4) Remove idle LB/NAT/VPN 5) S3 lifecycle + Intelligent-Tiering 6) Fix EKS versions + Spot/Karpenter 7) Prune secrets/logs/alarms.<br><b>Safety:</b> read-only audit — snapshot before any delete; apply in dev first.";

/** "Prioritized Savings Plan" paragraphs in the DOCX report (write_docx). */
export const PRIORITIZED_PLAN: string[] = [
	"1. EC2: rightsize <15% CPU, stop schedules, Savings Plans.",
	"2. RDS: downsize idle, RI for steady, autoscaling storage.",
	"3. EC2-Other: delete available EBS, release EIP, prune snapshots.",
	"4. ELB/VPC: delete 0-target LBs, idle NAT/VPN, use VPC endpoints.",
	"5. S3: lifecycle + Intelligent-Tiering + abort multipart.",
	"6. EKS: upgrade, Spot/Karpenter, delete idle clusters.",
	"7. Secrets/CloudWatch: delete stale secrets, log retention 30-90d.",
];

/** Candidate detail+recommendation separator in the DOCX findings table. */
export const DETAIL_REC_SEPARATOR = " → ";

/**
 * The finite set of finding category labels. Kept in one place so the scanners
 * and any UI filters agree on the vocabulary.
 */
export const CATEGORY = {
	ec2Stopped: "Idle — Stopped",
	ec2LowCpu: "Idle — Low CPU",
	ec2Underutilized: "Waste — Underutilized",
	ec2OldGen: "Waste — Old generation",
	ec2Healthy: "OK — Healthy",
	ec2NoMetrics: "Info — No metrics",
	ebsUnattached: "Waste — Unattached volume",
	ebsLowIo: "Idle — Near-zero I/O",
	ebsGp2: "Waste — gp2 (migrate to gp3)",
	ebsInUse: "OK — In use",
	snapSummary: "Summary — Snapshot sprawl",
	snapBaseSprawl: "Waste — Snapshot sprawl",
	snapOldUnlinked: "Waste — Old unlinked snapshot",
	snapLargeUnlinked: "Review — Large unlinked snapshot",
	ec2OtherEip: "Waste — Unassociated EIP",
	ec2OtherUnattachedEbs: "Waste — Unattached EBS",
	rdsStopped: "Idle — Stopped",
	rdsLowUse: "Idle — Low use",
	rdsOversized: "Waste — Oversized",
	rdsOldClass: "Waste — Old class",
	rdsGp2: "Waste — gp2 storage",
	rdsRisk: "Risk note (not saving)",
	rdsHealthy: "OK — Healthy",
	elbNoTargets: "Idle — No healthy targets",
	elbNearZero: "Idle — Near-zero traffic",
	elbClassicEmpty: "Idle — Classic ELB empty",
	elbInUse: "OK — In use",
	vpcNatIdle: "Idle — NAT Gateway",
	vpcNatReview: "Review — Low-traffic NAT",
	vpcVpnUnused: "Waste — Unused VPN",
	eksOldVersion: "Waste — Old K8s version",
	eksNoNodegroups: "Idle — No nodegroups",
	eksNodegroupSizing: "Waste — Nodegroup sizing",
	secretUnused: "Waste — Unused secret",
	cwNeverExpire: "Waste — Logs never expire",
	cwHighIngest: "Review — High ingestion",
	cwDeadAlarms: "Waste — Dead alarms",
	cwTruncated: "Summary — Truncated",
	s3IdleBucket: "Idle — Near-empty / unused bucket",
	s3NoLifecycle: "Waste — No lifecycle policy",
	s3Versioned: "Waste — Versioned without expiry",
	s3Footprint: "Summary — S3 footprint",
	s3Truncated: "Summary — Truncated scan",
	accessIssue: "AccessIssue",
} as const;

export type CategoryLabel = (typeof CATEGORY)[keyof typeof CATEGORY];
