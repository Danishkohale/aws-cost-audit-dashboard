import { beforeAll, describe, expect, it } from "vitest";
import type { Finding, Payload } from "../../src/types";
import { runAwsAudit } from "../../src/aws/audit";
import { cwDispatch, dims, fakeAws } from "./fake";

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

/**
 * A small synthetic account exercising one representative resource per rule:
 * stopped + idle EC2, unattached EBS, old snapshot, oversized prod RDS (gp2),
 * idle ALB, idle NAT, old empty EKS, stale secret, never-expiring log group,
 * and two S3 buckets (one without a lifecycle policy).
 */
function fixture() {
	const cw = cwDispatch({
		"AWS/EC2|CPUUtilization": (i) => {
			const id = dims(i, "InstanceId");
			if (id === "i-idle") return { Datapoints: [{ Average: 3.2, Maximum: 9.1 }] };
			return { Datapoints: [] };
		},
		"AWS/EC2|NetworkIn": () => ({ Datapoints: [{ Sum: 4e8 }] }),
		"AWS/EC2|NetworkOut": () => ({ Datapoints: [{ Sum: 2e8 }] }),
		"AWS/RDS|CPUUtilization": () => ({ Datapoints: [{ Average: 9.1, Maximum: 22.4 }] }),
		"AWS/RDS|DatabaseConnections": () => ({ Datapoints: [{ Average: 3 }] }),
		"AWS/EBS|VolumeReadOps": () => ({ Datapoints: [{ Sum: 0 }] }),
		"AWS/EBS|VolumeWriteOps": () => ({ Datapoints: [{ Sum: 0 }] }),
		"AWS/NATGateway|BytesOutToDestination": () => ({ Datapoints: [{ Sum: 4e8 }] }),
		"AWS/NATGateway|BytesInFromSource": () => ({ Datapoints: [{ Sum: 2e8 }] }),
		"AWS/S3|BucketSizeBytes": (i) =>
			dims(i, "BucketName") === "b1" ? { Datapoints: [{ Average: 48.2e9 }] } : { Datapoints: [] },
		"AWS/S3|NumberOfObjects": (i) =>
			dims(i, "BucketName") === "b1" ? { Datapoints: [{ Average: 12400 }] } : { Datapoints: [] },
		"AWS/S3|GetRequests": (i) =>
			dims(i, "BucketName") === "b1" ? { Datapoints: [{ Sum: 1120 }] } : { Datapoints: [] },
		"AWS/S3|PutRequests": (i) =>
			dims(i, "BucketName") === "b1" ? { Datapoints: [{ Sum: 340 }] } : { Datapoints: [] },
	});

	return fakeAws({
		sts: { GetCallerIdentityCommand: () => ({ Arn: "arn:aws:iam::123456789012:user/audit" }) },
		ce: {
			GetCostAndUsageCommand: () => ({
				ResultsByTime: [
					{
						Groups: [
							{
								Keys: ["Amazon Elastic Compute Cloud - Compute"],
								Metrics: { UnblendedCost: { Amount: "182.4" } },
							},
							{ Keys: ["Amazon QuickSight"], Metrics: { UnblendedCost: { Amount: "9.9" } } },
						],
					},
				],
			}),
		},
		ec2: {
			DescribeInstancesCommand: () => ({
				Reservations: [
					{
						Instances: [
							{
								InstanceId: "i-stopped",
								InstanceType: "t3.medium",
								State: { Name: "stopped" },
								LaunchTime: ago(21),
								Placement: { AvailabilityZone: "ap-south-1b" },
								BlockDeviceMappings: [{ DeviceName: "/dev/xvda" }],
							},
							{
								InstanceId: "i-idle",
								InstanceType: "t3.medium",
								State: { Name: "running" },
								LaunchTime: ago(21),
								Placement: { AvailabilityZone: "ap-south-1b" },
								BlockDeviceMappings: [],
							},
						],
					},
				],
			}),
			DescribeVolumesCommand: () => ({
				Volumes: [
					{
						VolumeId: "vol-1",
						Size: 100,
						VolumeType: "gp3",
						State: "available",
						AvailabilityZone: "ap-south-1b",
						CreateTime: ago(64),
						Attachments: [],
					},
				],
			}),
			DescribeAddressesCommand: () => ({ Addresses: [] }),
			DescribeSnapshotsCommand: () => ({
				Snapshots: [
					{ SnapshotId: "snap-1", VolumeSize: 80, StartTime: ago(132), Description: "old" },
				],
			}),
			DescribeImagesCommand: () => ({ Images: [] }),
			DescribeNatGatewaysCommand: () => ({
				NatGateways: [
					{ NatGatewayId: "nat-1", State: "available", SubnetId: "subnet-1", CreateTime: ago(90) },
				],
			}),
			DescribeVpnConnectionsCommand: () => ({ VpnConnections: [] }),
		},
		elbv2: {
			DescribeLoadBalancersCommand: () => ({
				LoadBalancers: [
					{
						LoadBalancerArn:
							"arn:aws:elasticloadbalancing:ap-south-1:123:loadbalancer/app/demo-alb/abc",
						LoadBalancerName: "demo-alb",
						Type: "application",
						Scheme: "internal",
						CreatedTime: ago(90),
					},
				],
			}),
			DescribeTargetGroupsCommand: () => ({ TargetGroups: [] }),
		},
		elb: { DescribeLoadBalancersCommand: () => ({ LoadBalancerDescriptions: [] }) },
		rds: {
			DescribeDBInstancesCommand: () => ({
				DBInstances: [
					{
						DBInstanceIdentifier: "prod-orders-db",
						DBInstanceClass: "db.m5.large",
						Engine: "mysql",
						EngineVersion: "8.0",
						DBInstanceStatus: "available",
						MultiAZ: false,
						AllocatedStorage: 100,
						StorageType: "gp2",
						InstanceCreateTime: ago(200),
						BackupRetentionPeriod: 7,
					},
				],
			}),
		},
		eks: {
			ListClustersCommand: () => ({ clusters: ["demo-cluster"] }),
			DescribeClusterCommand: () => ({ cluster: { name: "demo-cluster", version: "1.27" } }),
			ListNodegroupsCommand: () => ({ nodegroups: [] }),
		},
		secrets: {
			ListSecretsCommand: () => ({ SecretList: [{ Name: "old-secret" }] }),
			DescribeSecretCommand: () => ({ Name: "old-secret" }),
		},
		logs: {
			DescribeLogGroupsCommand: () => ({
				logGroups: [{ logGroupName: "/aws/lambda/order-api", storedBytes: 9.6e9 }],
			}),
		},
		cw: { ...cw, DescribeAlarmsCommand: () => ({ MetricAlarms: [] }) },
		s3: {
			ListBucketsCommand: () => ({ Buckets: [{ Name: "b1" }, { Name: "b2" }] }),
			GetBucketLifecycleConfigurationCommand: (i) =>
				i.Bucket === "b2"
					? { Rules: [{ Status: "Enabled" }] }
					: (() => {
							throw new Error("NoSuchLifecycleConfiguration");
						})(),
			GetBucketVersioningCommand: (i) => ({ Status: i.Bucket === "b1" ? "Enabled" : "Suspended" }),
		},
	});
}

function hits(findings: Finding[], service: string, category: string): Finding[] {
	return findings.filter((f) => f.service === service && f.category === category);
}

/** The deep-layer (meta-carrying) row for a resource, distinct from the base row. */
function detailOf(findings: Finding[], service: string, resource: string): string | undefined {
	return findings.find((f) => f.service === service && f.resource === resource && f.meta)?.detail;
}

describe("AWS audit layer (mocked SDK)", () => {
	let payload!: Payload;
	let logs: string[] = [];

	beforeAll(async () => {
		logs = [];
		payload = await runAwsAudit(fixture(), {
			days: 14,
			log: (m) => logs.push(m),
			accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		});
	});

	it("runs the full audit without throwing", () => {
		expect(payload.region).toBe("ap-south-1");
		expect(payload.lookback_days).toBe(14);
		expect(logs.some((l) => l.includes("AKIA****MPLE"))).toBe(true);
		expect(logs.some((l) => l.includes("STS check"))).toBe(false);
		expect(logs.some((l) => l.includes("[detail] done (+"))).toBe(true);
	});

	it("maps Cost Explorer spend and skips QuickSight", () => {
		expect(payload.live_cost_by_service).toEqual({ "EC2-Instances": 182.4 });
		expect(payload.cost_note).toMatch(/QuickSight excluded/);
	});

	it("produces both the base and deep layers", () => {
		// Base scan services + deep-detail services both appear.
		expect(hits(payload.findings, "EC2-Instances", "Idle — Stopped")).toHaveLength(1);
		expect(hits(payload.findings, "EC2", "Idle — Stopped")).toHaveLength(1);
		expect(hits(payload.findings, "EC2", "Idle — Low CPU")).toHaveLength(1);
		expect(hits(payload.findings, "EC2-Other", "Waste — Unattached EBS")).toHaveLength(1);
		expect(hits(payload.findings, "EBS", "Waste — Unattached volume")).toHaveLength(1);
		expect(hits(payload.findings, "Snapshot", "Waste — Old unlinked snapshot")).toHaveLength(1);
	});

	it("covers RDS, ELB, VPC, EKS, Secrets, CloudWatch and S3 rules", () => {
		expect(hits(payload.findings, "RDS", "Waste — Oversized")).toHaveLength(2); // base + detail
		expect(hits(payload.findings, "RDS", "Risk note (not saving)")).toHaveLength(1);
		expect(hits(payload.findings, "RDS", "Waste — gp2 storage")).toHaveLength(1);
		expect(hits(payload.findings, "ELB", "Idle — No healthy targets")).toHaveLength(2);
		expect(hits(payload.findings, "VPC", "Idle — NAT Gateway")).toHaveLength(2);
		expect(hits(payload.findings, "EKS", "Waste — Old K8s version")).toHaveLength(1);
		expect(hits(payload.findings, "EKS", "Idle — No nodegroups")).toHaveLength(1);
		expect(hits(payload.findings, "Secrets Manager", "Waste — Unused secret")).toHaveLength(1);
		expect(hits(payload.findings, "CloudWatch", "Waste — Logs never expire")).toHaveLength(2);
		expect(hits(payload.findings, "S3", "Summary — S3 footprint")).toHaveLength(1);
		expect(hits(payload.findings, "S3", "Waste — No lifecycle policy")).toHaveLength(2); // base example + detail
	});

	it("formats numbers and wording like the Python engine", () => {
		expect(detailOf(payload.findings, "EC2", "i-idle")).toBe(
			"t3.medium in ap-south-1b, running 21d. I/O: CPU avg 3.2% / max 9.1%, net in/out 0.4/0.2 GB/14d. ~$30/mo compute for <5% CPU.",
		);
		expect(detailOf(payload.findings, "EBS", "vol-1")).toBe(
			"100GB gp3 in ap-south-1b, age 64d. I/O: read 0 + write 0 ops/14d. Costs ~$8.0/mo for nothing.",
		);
		expect(detailOf(payload.findings, "RDS", "prod-orders-db")).toBe(
			"db.m5.large mysql 8.0, 100GB gp2. I/O: CPU avg 9.1%/max 22.4%, conns avg 3. ~$150/mo.",
		);
		expect(detailOf(payload.findings, "S3", "b1")).toBe(
			"Versioning=Enabled. I/O: size 48.2GB, 12,400 objects, GET 1120 / PUT 340 per 14d. ~$1.11/mo Standard; old versions accumulate. Est. save ~$0.48/mo via IA/Glacier transitions.",
		);
		// Base-layer strings.
		const unattached = hits(payload.findings, "EC2-Other", "Waste — Unattached EBS")[0];
		expect(unattached.detail).toBe("100GB gp3 in ap-south-1b. ~$8/mo.");
		expect(unattached.est_monthly_saving_usd).toBe(8);
	});

	it("computes savings with the same multipliers as the Python source", () => {
		expect(hits(payload.findings, "EC2", "Idle — Low CPU")[0].est_monthly_saving_usd).toBe(18); // 30 * 0.6
		expect(hits(payload.findings, "RDS", "Waste — Oversized")[1].est_monthly_saving_usd).toBe(60); // 150 * 0.4
		expect(
			hits(payload.findings, "EBS", "Waste — Unattached volume")[0].est_monthly_saving_usd,
		).toBe(8);
		expect(
			hits(payload.findings, "Snapshot", "Waste — Old unlinked snapshot")[0].est_monthly_saving_usd,
		).toBe(4); // 80 * 0.05
	});

	it("attaches structured meta to detail rows only", () => {
		const withMeta = payload.findings.filter((f) => f.meta);
		expect(withMeta.length).toBeGreaterThan(0);
		const ec2Meta = hits(payload.findings, "EC2", "Idle — Low CPU")[0].meta;
		expect(ec2Meta?.instance_type).toBe("t3.medium");
		expect(ec2Meta?.cpu_avg).toBe(3.2);
		// Base rows never carry meta.
		expect(hits(payload.findings, "EC2-Instances", "Idle — Stopped")[0].meta).toBeUndefined();
	});
});
