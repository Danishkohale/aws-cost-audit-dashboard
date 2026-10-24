/**
 * Chunked fan-out tests — the load-bearing guarantee for the Free plan.
 *
 * A synthetic *large* account (dozens to hundreds of resources per service) is
 * scanned twice:
 *   1. chunked, exactly as `POST /api/collect/:step` drives it, and
 *   2. in one unbounded pass, as `runAwsAudit()` does.
 *
 * The assertions are:
 *   * no single chunk issues more than 45 subrequests (Free plan allows 50), and
 *   * the chunked run produces exactly the same findings as the unbounded run.
 *
 * If a future chunk size or scanner change breaks either property, this fails.
 */
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/types";
import { SCAN_STEPS, type StepDef } from "../src/collect/registry";
import { decodeCursor, encodeCursor } from "../src/collect/cursor";
import { cwDispatch, fakeAws } from "./aws/fake";

/** Free plan allows 50 subrequests per invocation; leave headroom for retries. */
const BUDGET = 45;
const LOOKBACK = 14;

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const many = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

/** Shared counter so the fake client reports how many AWS calls it served. */
interface Counter {
	n: number;
}

function account(counter: Counter) {
	const onSend = () => {
		counter.n += 1;
	};

	const instances = [
		...many(30, (i) => ({
			InstanceId: `i-run-${i}`,
			InstanceType: "t3.medium",
			State: { Name: "running" },
			LaunchTime: ago(30),
			Placement: { AvailabilityZone: "ap-south-1a" },
			BlockDeviceMappings: [{ DeviceName: "/dev/xvda" }],
		})),
		...many(30, (i) => ({
			InstanceId: `i-stop-${i}`,
			InstanceType: "t2.large",
			State: { Name: "stopped" },
			LaunchTime: ago(90),
			Placement: { AvailabilityZone: "ap-south-1b" },
			BlockDeviceMappings: [],
		})),
	];

	const volumes = many(40, (i) => ({
		VolumeId: `vol-${i}`,
		Size: 100,
		VolumeType: i % 2 ? "gp2" : "gp3",
		State: i % 2 ? "available" : "in-use",
		AvailabilityZone: "ap-south-1a",
		CreateTime: ago(120),
		Attachments: i % 2 ? [] : [{ InstanceId: "i-run-0" }],
	}));

	const snapshots = many(80, (i) => ({
		SnapshotId: `snap-${i}`,
		VolumeSize: 80,
		StartTime: ago(100 + i),
		Description: `snap ${i}`,
	}));

	const dbs = many(25, (i) => ({
		DBInstanceIdentifier: `prod-db-${i}`,
		DBInstanceClass: "db.m5.large",
		Engine: "mysql",
		EngineVersion: "8.0",
		DBInstanceStatus: "available",
		MultiAZ: false,
		AllocatedStorage: 100,
		StorageType: "gp2",
		InstanceCreateTime: ago(200),
		BackupRetentionPeriod: 7,
	}));

	const lbs = many(20, (i) => ({
		LoadBalancerArn: `arn:aws:elasticloadbalancing:ap-south-1:123456789012:loadbalancer/app/lb-${i}/abc`,
		LoadBalancerName: `lb-${i}`,
		Type: "application",
		Scheme: "internal",
		CreatedTime: ago(90),
	}));

	const cw = cwDispatch({
		"AWS/EC2|CPUUtilization": () => ({ Datapoints: [{ Average: 3.2, Maximum: 9.1 }] }),
		"AWS/EC2|NetworkIn": () => ({ Datapoints: [{ Sum: 4e8 }] }),
		"AWS/EC2|NetworkOut": () => ({ Datapoints: [{ Sum: 2e8 }] }),
		"AWS/EBS|VolumeReadOps": () => ({ Datapoints: [{ Sum: 0 }] }),
		"AWS/EBS|VolumeWriteOps": () => ({ Datapoints: [{ Sum: 0 }] }),
		"AWS/RDS|CPUUtilization": () => ({ Datapoints: [{ Average: 9.1, Maximum: 22.4 }] }),
		"AWS/RDS|DatabaseConnections": () => ({ Datapoints: [{ Average: 3 }] }),
		"AWS/RDS|FreeStorageSpace": () => ({ Datapoints: [{ Minimum: 5e9 }] }),
		"AWS/RDS|ReadIOPS": () => ({ Datapoints: [{ Average: 10 }] }),
		"AWS/RDS|WriteIOPS": () => ({ Datapoints: [{ Average: 10 }] }),
		"AWS/NATGateway|BytesOutToDestination": () => ({ Datapoints: [{ Sum: 4e8 }] }),
		"AWS/NATGateway|BytesInFromSource": () => ({ Datapoints: [{ Sum: 2e8 }] }),
		"AWS/S3|BucketSizeBytes": () => ({ Datapoints: [{ Average: 48.2e9 }] }),
		"AWS/S3|NumberOfObjects": () => ({ Datapoints: [{ Average: 12400 }] }),
		"AWS/S3|GetRequests": () => ({ Datapoints: [{ Sum: 1120 }] }),
		"AWS/S3|PutRequests": () => ({ Datapoints: [{ Sum: 340 }] }),
		"AWS/Logs|IncomingBytes": () => ({ Datapoints: [{ Sum: 6e9 }] }),
		"AWS/Logs|IncomingLogEvents": () => ({ Datapoints: [{ Sum: 1000 }] }),
		"AWS/ApplicationELB|RequestCount": () => ({ Datapoints: [{ Sum: 500 }] }),
		"AWS/ApplicationELB|ProcessedBytes": () => ({ Datapoints: [{ Sum: 2e9 }] }),
	});

	return fakeAws(
		{
			ec2: {
				DescribeInstancesCommand: () => ({ Reservations: [{ Instances: instances }] }),
				DescribeVolumesCommand: () => ({ Volumes: volumes }),
				DescribeAddressesCommand: () => ({ Addresses: [] }),
				DescribeSnapshotsCommand: () => ({ Snapshots: snapshots }),
				DescribeImagesCommand: () => ({ Images: [] }),
				DescribeNatGatewaysCommand: () => ({
					NatGateways: many(25, (i) => ({
						NatGatewayId: `nat-${i}`,
						State: "available",
						SubnetId: `subnet-${i}`,
						CreateTime: ago(90),
					})),
				}),
				DescribeVpnConnectionsCommand: () => ({ VpnConnections: [] }),
			},
			elbv2: {
				DescribeLoadBalancersCommand: () => ({ LoadBalancers: lbs }),
				DescribeTargetGroupsCommand: (i) => ({
					TargetGroups: [{ TargetGroupArn: `arn:tg/${String(i.LoadBalancerArn)}` }],
				}),
				DescribeTargetHealthCommand: () => ({
					TargetHealthDescriptions: [{ TargetHealth: { State: "healthy" } }],
				}),
			},
			elb: { DescribeLoadBalancersCommand: () => ({ LoadBalancerDescriptions: [] }) },
			rds: { DescribeDBInstancesCommand: () => ({ DBInstances: dbs }) },
			eks: {
				ListClustersCommand: () => ({ clusters: many(6, (i) => `cluster-${i}`) }),
				DescribeClusterCommand: () => ({ cluster: { version: "1.27" } }),
				ListNodegroupsCommand: () => ({ nodegroups: [] }),
			},
			secrets: {
				ListSecretsCommand: () => ({ SecretList: many(50, (i) => ({ Name: `secret-${i}` })) }),
				DescribeSecretCommand: () => ({ Name: "x" }),
			},
			logs: {
				DescribeLogGroupsCommand: () => ({
					logGroups: many(120, (i) => ({
						logGroupName: `/aws/lambda/fn-${i}`,
						storedBytes: 9.6e9,
					})),
				}),
			},
			cw: { ...cw, DescribeAlarmsCommand: () => ({ MetricAlarms: [] }) },
			s3: {
				ListBucketsCommand: () => ({ Buckets: many(30, (i) => ({ Name: `bucket-${i}` })) }),
				// Half the buckets have no lifecycle policy at all, which is the
				// finding the deep S3 layer exists to surface.
				GetBucketLifecycleConfigurationCommand: (i) => {
					const idx = Number(String(i.Bucket).replace("bucket-", ""));
					if (idx % 2 === 0) throw new Error("NoSuchLifecycleConfiguration");
					return { Rules: [{ Status: "Enabled" }] };
				},
				GetBucketVersioningCommand: (i) => ({
					Status:
						Number(String(i.Bucket).replace("bucket-", "")) % 6 === 0 ? "Enabled" : "Suspended",
				}),
			},
		},
		onSend,
	);
}

function identity(f: Finding): string {
	return JSON.stringify([
		f.service,
		f.resource,
		f.category,
		f.detail,
		f.est_monthly_saving_usd,
		f.recommendation,
	]);
}

/** Drive one step the way the browser does, one bounded call at a time. */
async function driveStep(step: StepDef) {
	const counter: Counter = { n: 0 };
	const aws = account(counter);
	const findings: Finding[] = [];
	const callsPerChunk: number[] = [];
	let cursor: string | null = null;
	let guard = 0;

	for (;;) {
		if (guard++ > 500) throw new Error(`step ${step.name} never finished`);
		const decoded = decodeCursor(cursor);
		counter.n = 0;
		const result = await step.run(aws, findings, LOOKBACK, {
			offset: decoded?.offset ?? 0,
			limit: step.chunk,
			state: decoded?.state,
		});
		callsPerChunk.push(counter.n);
		cursor = encodeCursor(result.next, result.state);
		if (cursor === null) break;
	}

	return {
		findings,
		callsPerChunk,
		chunks: callsPerChunk.length,
		maxCalls: Math.max(...callsPerChunk),
	};
}

/** One unbounded pass, the `runAwsAudit()` behaviour. */
async function runWhole(step: StepDef): Promise<Finding[]> {
	const counter: Counter = { n: 0 };
	const aws = account(counter);
	const findings: Finding[] = [];
	await step.run(aws, findings, LOOKBACK);
	return findings;
}

const sorted = (xs: string[]) => [...xs].sort();

describe("chunked collect layer (Free-plan budget)", () => {
	it("never exceeds the per-invocation subrequest budget, for any step", async () => {
		const offenders: { step: string; maxCalls: number; chunk: number }[] = [];
		for (const step of SCAN_STEPS) {
			const { maxCalls } = await driveStep(step);
			if (maxCalls > BUDGET) {
				offenders.push({ step: step.name, maxCalls, chunk: step.chunk });
			}
		}
		expect(offenders).toEqual([]);
	});

	it("produces identical findings chunked vs in one unbounded pass", async () => {
		for (const step of SCAN_STEPS) {
			const chunked = await driveStep(step);
			const whole = await runWhole(step);
			expect(chunked.findings.length, `${step.name}: chunked finding count`).toBeGreaterThan(0);
			expect(sorted(chunked.findings.map(identity)), `${step.name}: findings differ`).toEqual(
				sorted(whole.map(identity)),
			);
		}
	});

	it("actually splits the heavy steps into several bounded calls", async () => {
		const chunks: Record<string, number> = {};
		for (const step of SCAN_STEPS) {
			chunks[step.name] = (await driveStep(step)).chunks;
		}
		// Sanity check that the fixture really exercises chunking, so the budget
		// assertion above is not passing vacuously.
		expect(chunks.ec2).toBeGreaterThan(1);
		expect(chunks["ec2-detail"]).toBeGreaterThan(1);
		expect(chunks["s3-detail"]).toBeGreaterThan(1);
		expect(chunks["cloudwatch-detail"]).toBeGreaterThan(1);
		expect(chunks.secrets).toBeGreaterThan(1);
		expect(chunks.rds).toBeGreaterThan(1);
	});

	it("spreads a large account over many invocations, none of them near the cap", async () => {
		let total = 0;
		let worst = 0;
		for (const step of SCAN_STEPS) {
			const { callsPerChunk } = await driveStep(step);
			total += callsPerChunk.reduce((a, b) => a + b, 0);
			worst = Math.max(worst, ...callsPerChunk);
		}
		// The account needs hundreds of AWS calls, which is impossible in one
		// invocation on the Free plan — that is precisely why the browser drives
		// the fan-out instead of the server looping.
		expect(total).toBeGreaterThan(200);
		expect(worst).toBeLessThanOrEqual(BUDGET);
	});
});
