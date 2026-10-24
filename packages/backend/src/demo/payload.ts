/**
 * Demo payload — port of the sample report in app.py:156-213.
 *
 * This is a hand-written sample so the dashboard works with **no AWS keys and
 * no AWS call**. It exercises the exact same report writers as a real audit.
 */
import type { Payload } from "../types";
import { CATEGORY } from "../rules/templates";
import { DEFAULT_REGION } from "../rules/thresholds";

/**
 * @param dateIso ISO date (YYYY-MM-DD) — injected so tests are deterministic.
 */
export function buildDemoPayload(dateIso: string): Payload {
	return {
		date: dateIso,
		region: DEFAULT_REGION,
		lookback_days: 14,
		live_cost_by_service: {
			"EC2-Instances": 2147.32,
			RDS: 1489.65,
			"EC2-Other": 312.45,
			ELB: 156.8,
			VPC: 128.4,
			EKS: 219.0,
			S3: 89.75,
			CloudWatch: 67.3,
			"Secrets Manager": 14.5,
		},
		cost_note: "Demo data — sample Cost Explorer window (QuickSight excluded).",
		findings: [
			// EC2 Findings
			{
				service: "EC2",
				resource: "i-0demo1234abcd",
				category: CATEGORY.ec2LowCpu,
				detail:
					"t3.medium in ap-south-1b, running 21d. I/O: CPU avg 3.2% / max 9.1%, net in/out 0.4/0.2 GB/14d. ~$30/mo compute for <5% CPU.",
				est_monthly_saving_usd: 18.0,
				recommendation: "Downsize 1-2 steps or schedule stop nights/weekends.",
				meta: {
					instance_type: "t3.medium",
					state: "running",
					age_days: 21,
					cpu_avg: 3.2,
					cpu_max: 9.1,
					base_cost_mo: 30,
				},
			},
			{
				service: "EC2",
				resource: "i-0prod5678efgh",
				category: CATEGORY.ec2Stopped,
				detail:
					"m5.xlarge in us-east-1a, stopped 45d. EBS still attached (200GB gp3). ~$134/mo wasted on stopped instance + EBS.",
				est_monthly_saving_usd: 134,
				recommendation: "Terminate if unneeded (snapshot first) or start/rightsize. Stopped instances still pay EBS.",
				meta: {
					instance_type: "m5.xlarge",
					state: "stopped",
					age_days: 45,
					cpu_avg: null,
					cpu_max: null,
					base_cost_mo: 134,
				},
			},
			{
				service: "EC2",
				resource: "i-0dev9999ijkl",
				category: CATEGORY.ec2Underutilized,
				detail:
					"r5.2xlarge in eu-west-1b, running 180d. I/O: CPU avg 12.4% / max 38.7%. Overprovisioned for workload.",
				est_monthly_saving_usd: 185,
				recommendation: "Rightsize one family down (r5.xlarge); check memory with CloudWatch Agent.",
				meta: {
					instance_type: "r5.2xlarge",
					state: "running",
					age_days: 180,
					cpu_avg: 12.4,
					cpu_max: 38.7,
					base_cost_mo: 462,
				},
			},
			{
				service: "EC2",
				resource: "i-0legacy3333mnop",
				category: CATEGORY.ec2OldGen,
				detail:
					"m4.2xlarge in ap-southeast-1a, running 365d. Previous-gen; ~20% pricier than m5 equivalent.",
				est_monthly_saving_usd: 89,
				recommendation: "Migrate m4.2xlarge → m5.2xlarge in a maintenance window.",
				meta: {
					instance_type: "m4.2xlarge",
					state: "running",
					age_days: 365,
					cpu_avg: 22.1,
					cpu_max: 55.3,
					base_cost_mo: 389,
				},
			},
			{
				service: "EC2",
				resource: "i-0batch7777qrst",
				category: CATEGORY.ec2LowCpu,
				detail:
					"c5.4xlarge in us-west-2c, running 14d. Batch job runner, CPU avg 2.1%. Only runs 2hrs/day.",
				est_monthly_saving_usd: 285,
				recommendation: "Use Spot instances or EventBridge scheduled start/stop; consider Fargate Spot for batch.",
				meta: {
					instance_type: "c5.4xlarge",
					state: "running",
					age_days: 14,
					cpu_avg: 2.1,
					cpu_max: 15.8,
					base_cost_mo: 476,
				},
			},

			// EC2-Other (EBS/EIP/Snapshots)
			{
				service: "EBS",
				resource: "vol-0demo9999",
				category: CATEGORY.ebsUnattached,
				detail:
					"100GB gp3 in ap-south-1b, age 64d. I/O: read 0 + write 0 ops/14d. Costs ~$8/mo for nothing.",
				est_monthly_saving_usd: 8.0,
				recommendation: "Snapshot then delete; add DLM retention.",
				meta: { size_gb: 100, type: "gp3", state: "available", age_days: 64, est_cost_mo: 8.0 },
			},
			{
				service: "EBS",
				resource: "vol-0prod1111",
				category: CATEGORY.ebsLowIo,
				detail:
					"500GB gp2 attached to i-0prod5678efgh (stopped). I/O: read 12 + write 8 ops/14d. ~$50/mo.",
				est_monthly_saving_usd: 25,
				recommendation: "Downsize volume, move cold data to S3/EFS, or snapshot + shrink.",
				meta: {
					size_gb: 500,
					type: "gp2",
					state: "in-use",
					attached_to: "i-0prod5678efgh",
					age_days: 210,
					az: "us-east-1a",
					read_ops_14d: 12,
					write_ops_14d: 8,
					est_cost_mo: 50,
				},
			},
			{
				service: "EBS",
				resource: "vol-0gp2legacy2222",
				category: CATEGORY.ebsGp2,
				detail:
					"1TB gp2 attached to i-0legacy3333mnop. gp3 is ~20% cheaper + tunable IOPS.",
				est_monthly_saving_usd: 20,
				recommendation: "Modify volume gp2→gp3 (online, no downtime).",
				meta: {
					size_gb: 1000,
					type: "gp2",
					state: "in-use",
					attached_to: "i-0legacy3333mnop",
					age_days: 400,
					az: "ap-southeast-1a",
					est_cost_mo: 100,
				},
			},
			{
				service: "EBS",
				resource: "vol-0datavol3333",
				category: CATEGORY.ebsUnattached,
				detail:
					"2TB gp3 in eu-west-1b, age 12d. Unattached after instance termination. ~$160/mo.",
				est_monthly_saving_usd: 160,
				recommendation: "Snapshot then delete; add DLM retention.",
				meta: {
					size_gb: 2000,
					type: "gp3",
					state: "available",
					age_days: 12,
					az: "eu-west-1b",
					est_cost_mo: 160,
				},
			},

			// Snapshots
			{
				service: "Snapshot",
				resource: "snap-0demo7777",
				category: CATEGORY.snapOldUnlinked,
				detail: "80GB, age 132d, ~$4/mo. Not linked to any AMI.",
				est_monthly_saving_usd: 4.0,
				recommendation: "Delete after verifying no restore need; enforce DLM 30-90d retention.",
				meta: { size_gb: 80, age_days: 132, ami_linked: false },
			},
			{
				service: "Snapshot",
				resource: "snap-0prod8888",
				category: CATEGORY.snapOldUnlinked,
				detail: "500GB, age 245d, ~$25/mo. Old production DB snapshot, not AMI-linked.",
				est_monthly_saving_usd: 25,
				recommendation: "Delete after verifying no restore need; enforce DLM 30-90d retention.",
				meta: { size_gb: 500, age_days: 245, ami_linked: false },
			},
			{
				service: "Snapshot",
				resource: "snap-0legacy9999",
				category: CATEGORY.snapLargeUnlinked,
				detail: "2TB, age 89d, ~$100/mo, unlinked. Large historical snapshot.",
				est_monthly_saving_usd: 50,
				recommendation: "Confirm restore need; else delete.",
				meta: { size_gb: 2000, age_days: 89, ami_linked: false },
			},

			// RDS
			{
				service: "RDS",
				resource: "prod-orders-db",
				category: CATEGORY.rdsOversized,
				detail:
					"db.m5.large MySQL, MultiAZ=False, 100GB gp2. I/O: CPU avg 9.1%/max 22.4%, conns avg 3, I/O read 12/write 30 IOPS, free storage 62.0GB. ~$150/mo.",
				est_monthly_saving_usd: 60,
				recommendation: "Rightsize down; move to gp3 + Storage Autoscaling.",
				meta: {
					class: "db.m5.large",
					cpu_avg: 9.1,
					conns_avg: 3,
					storage_gb: 100,
					base_cost_mo: 150,
				},
			},
			{
				service: "RDS",
				resource: "prod-analytics-db",
				category: CATEGORY.rdsLowUse,
				detail:
					"db.r5.2xlarge PostgreSQL, MultiAZ=True, 500GB gp2. CPU avg 3.2%, conns avg 1.5. ~$680/mo for dev workload.",
				est_monthly_saving_usd: 408,
				recommendation: "Downsize to db.r5.large or Aurora Serverless v2 for spiky workloads.",
				meta: {
					class: "db.r5.2xlarge",
					engine: "PostgreSQL 14.9",
					multiaz: true,
					storage_gb: 500,
					storage_type: "gp2",
					cpu_avg: 3.2,
					conns_avg: 1.5,
					base_cost_mo: 680,
				},
			},
			{
				service: "RDS",
				resource: "legacy-reporting-db",
				category: CATEGORY.rdsStopped,
				detail:
					"db.t3.medium MySQL, stopped 30d. Storage 100GB gp2 + snapshots still billed ~$12/mo.",
				est_monthly_saving_usd: 45,
				recommendation: "Snapshot then delete if dev/test; stopped >7d auto-starts — don't rely on stop for savings.",
				meta: {
					class: "db.t3.medium",
					engine: "MySQL 8.0",
					multiaz: false,
					storage_gb: 100,
					storage_type: "gp2",
					state: "stopped",
					age_days: 30,
					base_cost_mo: 45,
				},
			},
			{
				service: "RDS",
				resource: "prod-main-db",
				category: CATEGORY.rdsGp2,
				detail: "500GB gp2. gp3 + Storage Autoscaling would save ~$10/mo.",
				est_monthly_saving_usd: 10,
				recommendation: "Modify to gp3 + enable Storage Autoscaling.",
				meta: { storage_gb: 500, storage_type: "gp2" },
			},

			// S3
			{
				service: "S3",
				resource: "app-uploads-prod",
				category: CATEGORY.s3NoLifecycle,
				detail:
					"Versioning=Enabled, lifecycle=off. I/O: size 48.2GB, 12,400 objects, GET 1,120 / PUT 340 per 14d. ~$1.11/mo Standard; est. save ~$0.48/mo via IA/Glacier transitions.",
				est_monthly_saving_usd: 0.48,
				recommendation:
					"Add lifecycle: noncurrent expire 30-90d, >30d Standard-IA, >90d Glacier, abort multipart 7d.",
				meta: {
					bucket: "app-uploads-prod",
					size_gb: 48.2,
					objects: 12400,
					gets: 1120,
					puts: 340,
					lifecycle: false,
				},
			},
			{
				service: "S3",
				resource: "old-backups-2019",
				category: CATEGORY.s3IdleBucket,
				detail:
					"Versioning=Suspended, lifecycle=off. I/O: size 0.0GB, 3 objects, GET 2 / PUT 0 per 14d. Costs ~$0/mo + request fees.",
				est_monthly_saving_usd: 0.0,
				recommendation: "Delete if unneeded (check app refs first).",
				meta: { bucket: "old-backups-2019", size_gb: 0.0, objects: 3, gets: 2, puts: 0 },
			},
			{
				service: "S3",
				resource: "data-lake-raw",
				category: CATEGORY.s3NoLifecycle,
				detail:
					"Versioning=Enabled, lifecycle=off. I/O: size 2.4TB, 4.2M objects. ~$55/mo Standard; est. save ~$200/mo via Intelligent-Tiering + Glacier.",
				est_monthly_saving_usd: 200,
				recommendation:
					"Add lifecycle: noncurrent expire 90d, >30d Standard-IA, >90d Glacier Deep Archive, Intelligent-Tiering for unpredictable access.",
				meta: {
					bucket: "data-lake-raw",
					size_gb: 2457.6,
					objects: 4200000,
					gets: 45000,
					puts: 12000,
					lifecycle: false,
				},
			},
			{
				service: "S3",
				resource: "logs-archive-2023",
				category: CATEGORY.s3Versioned,
				detail:
					"Versioning=Enabled, no noncurrent expiry. I/O: size 800GB. Noncurrent versions billed forever (~$16/mo).",
				est_monthly_saving_usd: 12,
				recommendation: "Add noncurrent-version expiry 30-90d.",
				meta: {
					bucket: "logs-archive-2023",
					size_gb: 800,
					versioning: "Enabled",
					lifecycle: true,
					est_cost_mo: 16,
				},
			},

			// CloudWatch
			{
				service: "CloudWatch",
				resource: "/aws/lambda/order-api",
				category: CATEGORY.cwNeverExpire,
				detail:
					"I/O: ingest 0.42 GB/day, 88,000 events/14d, stored 9.6GB, retention NeverExpire. Ingest ~$6.3/mo + storage ~$0.29/mo.",
				est_monthly_saving_usd: 1.46,
				recommendation: "Set retention 14-90d; export to S3 Glacier; cut DEBUG logging.",
				meta: { stored_gb: 9.6, ingest_gb_day: 0.42, est_ingest_mo: 6.3 },
			},
			{
				service: "CloudWatch",
				resource: "/aws/ecs/prod-cluster",
				category: CATEGORY.cwHighIngest,
				detail:
					"I/O: ingest 12.8 GB/day, 2.1M events/14d, stored 45GB, retention 365d. Ingest ~$192/mo dominates.",
				est_monthly_saving_usd: 57,
				recommendation: "Sample/debug at lower verbosity; use metric filters + S3 export.",
				meta: { stored_gb: 45, ingest_gb_day: 12.8, est_ingest_mo: 192 },
			},
			{
				service: "CloudWatch",
				resource: "/aws/rds/prod-db",
				category: CATEGORY.cwNeverExpire,
				detail:
					"I/O: ingest 0.15 GB/day, 22,000 events/14d, stored 3.2GB, retention NeverExpire. Ingest ~$2.25/mo + storage ~$0.1/mo.",
				est_monthly_saving_usd: 0.52,
				recommendation: "Set retention 14-90d; export to S3 Glacier for compliance.",
				meta: { stored_gb: 3.2, ingest_gb_day: 0.15, est_ingest_mo: 2.25 },
			},

			// VPC
			{
				service: "VPC",
				resource: "nat-0demo5555",
				category: CATEGORY.vpcNatIdle,
				detail: "Available. I/O: out 0.3GB + in 0.2GB per 14d, age 90d. Base ~$32/mo + per-GB.",
				est_monthly_saving_usd: 32,
				recommendation: "Remove if no private subnets need egress; add S3/DynamoDB VPC endpoints.",
				meta: { age_days: 90, out_gb: 0.3 },
			},
			{
				service: "VPC",
				resource: "nat-0prod1111",
				category: CATEGORY.vpcNatReview,
				detail: "I/O: out 12GB + in 8GB per 14d, age 45d, subnet subnet-0abcd1234. Base $32/mo dominates at this volume.",
				est_monthly_saving_usd: 10,
				recommendation: "Consolidate AZs or use VPC endpoints for S3/DynamoDB.",
				meta: { age_days: 45, out_gb: 12, out_gb: 8 },
			},

			// ELB
			{
				service: "ELB",
				resource: "demo-alb",
				category: CATEGORY.elbNoTargets,
				detail:
					"application internal. I/O: 0 req/14d, 0.0GB processed, targets 0 healthy/2 unhealthy. Base ~$16-25/mo + LCU.",
				est_monthly_saving_usd: 20,
				recommendation: "Delete idle LB or fix target health.",
				meta: { type: "application", healthy: 0, unhealthy: 2, requests: 0 },
			},
			{
				service: "ELB",
				resource: "prod-external-alb",
				category: CATEGORY.elbNearZero,
				detail:
					"application internet-facing. I/O: 1,240 req/14d, 0.04GB processed, targets 3 healthy. ~$22/mo for minimal traffic.",
				est_monthly_saving_usd: 18,
				recommendation: "Consolidate listeners onto one ALB; delete unused LBs.",
				meta: { type: "application", healthy: 3, unhealthy: 0, requests: 1240 },
			},

			// EKS
			{
				service: "EKS",
				resource: "prod-cluster",
				category: CATEGORY.eksNodegroupSizing,
				detail:
					"desired=6, [m5.xlarge]. EKS control plane $73/mo + nodegroup ~$540/mo. Consider Karpenter + Spot.",
				est_monthly_saving_usd: 200,
				recommendation: "Use Karpenter/CA + Spot, Graviton (m7g), right-size via Container Insights.",
				meta: { instance_types: ["m5.xlarge"], desired_size: 6 },
			},
			{
				service: "EKS",
				resource: "dev-cluster",
				category: CATEGORY.eksNoNodegroups,
				detail: "Cluster with no nodegroups still pays $73/mo control plane. Dev cluster unused 60d.",
				est_monthly_saving_usd: 73,
				recommendation: "Delete idle cluster or run workloads on Fargate Spot.",
				meta: { nodegroups: [] },
			},

			// Secrets Manager
			{
				service: "Secrets Manager",
				resource: "prod/db/credentials",
				category: CATEGORY.secretUnused,
				detail: "Not accessed in 90d+ (last=null). $0.40/secret/mo + API. Old credentials from migrated service.",
				est_monthly_saving_usd: 0.4,
				recommendation: "Delete unused secret (recoverable 7-30d) or consolidate JSON into one secret.",
				meta: { last_accessed: null },
			},
			{
				service: "Secrets Manager",
				resource: "legacy/api-keys-2022",
				category: CATEGORY.secretUnused,
				detail: "Not accessed in 180d+ (last=2023-04-15). API keys for decommissioned 3rd-party integration.",
				est_monthly_saving_usd: 0.4,
				recommendation: "Delete unused secret (recoverable 7-30d) or consolidate JSON into one secret.",
				meta: { last_accessed: "2023-04-15" },
			},
		],
	};
}