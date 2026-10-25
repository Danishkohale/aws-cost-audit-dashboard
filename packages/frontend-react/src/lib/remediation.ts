/**
 * Remediation steps — concrete "what to do" guidance per finding.
 *
 * Steps are static, professional instructions (Console/CLI paths where
 * meaningful) generated from the finding's service + category. They never
 * promise a number that the backend didn't produce.
 */
import type { Finding } from "./api";

const S: Record<string, string[]> = {
	// ── EC2 ──────────────────────────────────────────────────────────
	"Idle — Low CPU": [
		"Open the instance in the EC2 console → Monitoring tab and confirm CloudWatch CPU stays below ~20% over 2–4 weeks (NetworkIn is low too).",
		"Decide between (a) right-sizing or (b) scheduling: right-size if load is steady-low; schedule stops with AWS Instance Scheduler if it's idle nights/weekends.",
		"To right-size: stop the instance (current-gen EBS-backed), Actions → Instance settings → Change instance type, pick 1–2 sizes smaller, then start it again.",
		"To schedule: launch the Instance Scheduler on AWS solution (Kb AWS-9961) or create an EventBridge rule + Lambda that stops/starts the instance by tag (e.g. schedule=office-hours).",
		"Re-check the next audit run and verify the instance no longer appears as Idle.",
	],
	"Idle — Stopped": [
		"Confirm with the owner that the instance is truly no longer needed — stopped instances still incur EBS storage charges every month.",
		"EC2 console → Actions → Image and templates → Create image (AMI) if a quick rollback may ever be needed.",
		"Snapshot the attached EBS volumes, then Terminate the instance.",
		"After 7–30 days, delete the leftover snapshots and volumes to fully reclaim the storage cost of the stopped instance.",
	],
	"Waste — Underutilized": [
		"Install the CloudWatch Agent (if not already) so memory utilisation is visible — CPU alone hides the true picture.",
		"Compare 30-day p95 CPU and memory against the instance size; if both are under ~40%, right-size to one instance family smaller.",
		"Stop → Change instance type → Start (current-gen EBS-backed instances support this).",
		"If the load is bursty rather than steady-low, consider a smaller instance + Auto Scaling instead of a fixed resize.",
	],
	"Waste — Old generation": [
		"Book a short maintenance window — this is an instance replacement, not a hot resize.",
		"Create an AMI of the old instance and launch the same config on the newer generation (e.g. m4 → m5/m6i, which costs 10–20% less and is faster).",
		"Migrate the Elastic IP and any required security groups, then swap the DNS/ENI so no IP changes are needed downstream.",
		"Terminate only after verification, and keep the AMI one billing cycle as a rollback path.",
	],

	// ── EBS ──────────────────────────────────────────────────────────
	"Waste — Unattached volume": [
		"EBS console → Volumes → State = 'available' — confirm the volume is not attached to any instance (including stopped ones).",
		"Snapshot it if there is any doubt about its contents.",
		"Delete the volume once confirmed — the charge repeats every month until removed.",
		"Prevent recurrence with a Data Lifecycle Manager (DLM) policy so snapshots have automatic expiry and old volumes get repurposed rather than forgotten.",
	],
	"Idle — Near-zero I/O": [
		"Check CloudWatch VolumeReadOps/VolumeWriteOps for the volume over 2 weeks — the low I/O has already been detected.",
		"Downsize the volume's provisioned IOPS/throughput (gp3 makes this a no-downtime change) instead of paying for oversized performance.",
		"If the data is cold, snapshot it, move the cold data to S3 (Glacier tier) and delete the volume when nothing needs block access.",
	],
	"Waste — gp2 (migrate to gp3)": [
		"EBS console → Volumes → Actions → Modify volume → Type: gp3.",
		"Keep the same provisioned IOPS the gp2 volume effectively had — the change is online and non-disruptive.",
		"Since gp3 is ~20% cheaper at the same performance, verify the change on the next bill; savings apply immediately.",
		"For newly created volumes, set the account's account-level default EBS encryption & gp3 defaults so new volumes never start on gp2.",
	],
	"Waste — Old unlinked snapshot": [
		"Verify the snapshot isn't referenced by an AMI or a launch template (EC2 console → AMIs → filter by snapshot).",
		"Confirm your restore/recovery policy — many orgs require snapshots 30–90 days old then deletion.",
		"Delete the snapshot and enforce a DLM retention rule (30–90 days) so old snapshots expire automatically.",
	],
	"Review — Large unlinked snapshot": [
		"Confirm no AMI/launch template references the snapshot and no compliance rule keeps it.",
		"Restore-test one volume from it (fast snapshot restore into a scratch environment) if the deletion feels risky.",
		"Once verified, delete it and record the decision — storage repays the effort immediately.",
	],
	"Waste — Oversized": [
		"Compare the volume's CloudWatch IOPS/throughput against what's provisioned — the stored signal says both are far above actual use.",
		"Modify volume → gp3 → set IOPS/throughput that match p99 usage (baseline 3,000 IOPS / 125 MB/s is the free floor).",
		"Enable EBS Storage Autoscaling so the size follows actual demand rather than an old over-provisioned setting.",
	],

	// ── RDS ──────────────────────────────────────────────────────────
	"Idle — Low use": [
		"Check CloudWatch DatabaseConnections and CPU for the instance over 2–4 weeks — usage has already been detected as very low.",
		"Right-size to one instance class smaller (Modify → Instance class) — RDS changes are applied in a maintenance window.",
		"For spiky workloads, switch to Aurora Serverless v2, which scales automatically between requests.",
		"Enable Storage Autoscaling at the same time so storage + IOPS follow real demand.",
	],
	"Waste — gp2 storage": [
		"RDS console → Modify → Storage type: General Purpose SSD gp3.",
		"Set allocated IOPS/throughput to match the DB's observed load — gp3 decouples them from the storage size.",
		"gp3 typically costs ~20% less at the same performance; apply in the maintenance window and verify with CloudWatch afterwards.",
		"Enable Storage Autoscaling so future data growth doesn't over-provision again.",
	],

	// ── S3 ──────────────────────────────────────────────────────────
	"Waste — No lifecycle policy": [
		"S3 console → Buckets → Management → 'Create lifecycle rule' (or a Terraform/CLI equivalent).",
		"Transition: Standard-IA after 30 days, Glacier Instant Retrieval after 90 days.",
		"Expire noncurrent versions after 30–90 days and abort incomplete multipart uploads after 7 days.",
		"Verify the rule is attached to the right prefix/tags and check the next audit for a reduced cost per GB.",
	],
	"Idle — Near-empty / unused bucket": [
		"List the objects in the bucket and grep your codebase/IaC for the bucket name — confirm nothing references it.",
		"Delete the bucket, or keep it but add a 7-day lifecycle expiry until you are certain no consumer appears.",
		"Block future zombie buckets with a tag (owner=team, purpose=…) and a periodic cleanup job.",
	],
	"Waste — Versioned without expiry": [
		"S3 console → Management → lifecycle rule → tick 'Delete noncurrent object versions'.",
		"Keep 30–90 days of noncurrent versions depending on your restore needs — older ones cost full price forever otherwise.",
		"Add an abort-incomplete-multipart rule (7 days) at the same time — silently expensive otherwise.",
	],

	// ── CloudWatch ──────────────────────────────────────────────────────────
	"Waste — Logs never expire": [
		"CloudWatch Logs console → Log groups → Actions → 'Put retention policy' → 30–90 days for most operational groups.",
		"Export anything worth keeping long-term to S3 (which has its own much cheaper lifecycle chain).",
		"Count DEBUG-level log groups and silence them at the source (libraries / log4j level) rather than paying to ingest what is never read.",
	],
	"Review — High ingestion": [
		"Identify which log groups drive the high billed ingestion (Logs console sorts by 'Bytes ingested').",
		"Replace repeated detailed logs with metric filters — emit a metric instead of storing every event.",
		"Sample noisy services (e.g. log every Nth request) and cut DEBUG pools at the source.",
	],

	// ── VPC / NAT ──────────────────────────────────────────────────────────
	"Idle — NAT Gateway": [
		"VPC console → NAT gateways → confirm near-zero BytesOutToDestination in CloudWatch.",
		"Check route tables — if no private subnet needs internet egress through it, delete the NAT gateway and the route entry.",
		"If some egress is needed only for S3/DynamoDB: add VPC endpoints for those services and drop the NAT gateway entirely (endpoints avoid the NAT processing charge).",
		"NAT gateways bill per hour AND per GB processed — deleting an unused one stops both charges immediately.",
	],
	"Review — Low-traffic NAT": [
		"Compare traffic per AZ; consolidate to one NAT gateway in a single-AZ subnet if the traffic is tiny and multi-AZ resilience is not required there.",
		"Add S3 / DynamoDB VPC endpoints so that traffic bypasses the NAT gateway entirely.",
	],

	// ── ELB ──────────────────────────────────────────────────────────
	"Idle — No healthy targets": [
		"EC2 console → Target groups → check each target's health history — no healthy target means the LB is receiving requests but serving nothing.",
		"Fix the root cause and re-register the targets if the service is meant to exist.",
		"If the whole stack behind it was already decommissioned, delete the load balancer (and its target groups if unused).",
		"Remember each idle ALB costs a fixed base + LCU — deletion stops both.",
	],
	"Idle — Near-zero traffic": [
		"Compare CloudWatch RequestCount / ProcessedBytes across your ALBs — near-zero traffic has already been measured.",
		"Consolidate listeners onto one LB (listener rules can route by host/path) and delete the unused one to stop the base charge.",
		"Consider CloudFront or Route 53 weighted routing if traffic was spread intentionally.",
	],

	// ── EKS ──────────────────────────────────────────────────────────
	"Waste — Nodegroup sizing": [
		"Review Container Insights / Kubernetes requests-vs-usage — oversized nodes carry real EC2 cost.",
		"Deploy Karpenter (or Cluster Autoscaler) with a right-sized, spot-friendly set of node types.",
		"Move stateless workloads to Spot and switch stable node pools to Graviton (m7g/c7g — ~20% cheaper).",
		"Use Bin-packing (Karpenter consolidation) so underutilised nodes are vacuumed automatically.",
	],
	"Idle — No nodegroups": [
		"Confirm the cluster runs no workloads (kubectl get nodes/pods per namespace) — an empty cluster still bills ~$0.10/hour plus any leftover ELBs/volumes.",
		"If it is truly idle, delete the EKS cluster and its VPC resources.",
		"If it will run workloads later, keep only the control plane and add Fargate Spot profiles when it is needed.",
	],

	// ── Secrets Manager ──────────────────────────────────────────────
	"Waste — Unused secret": [
		"Search CloudTrail for 'GetSecretValue' events to confirm nothing has read the secret recently.",
		"Delete the secret — Secrets Manager keeps it recoverable for 7–30 days, so mistakes are reversible.",
		"If several secrets hold one JSON document's fields, consolidate them into a single secret; pricing is per secret per month.",
	],
};

/** Fallback guidance for a category we haven't mapped explicitly. */
function generic(f: Finding): string[] {
	return [
		`Verify what ${f.resource} connects to and who owns it before changing it (tag owner / last access metadata).`,
		`Apply the recommended change: ${f.recommendation}`,
		"Watch CloudWatch for a week afterwards to confirm behaviour is unchanged.",
		"Re-run the audit and confirm the finding disappears, proving the saving is realised.",
	];
}

/** Pick guidance for service+category, falling back to generic steps. */
export function remediationSteps(f: Finding): string[] {
	const byCategory = S[f.category];
	if (byCategory) return byCategory;
	// Try service-level generic guidance.
	if (f.service === "EC2") return S["Idle — Low CPU"] ?? generic(f);
	return generic(f);
}
