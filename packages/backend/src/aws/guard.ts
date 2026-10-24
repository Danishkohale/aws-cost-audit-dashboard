/**
 * Read-only guard — the critical safety port of `cost-optimization.py:32-64`.
 *
 * Python enforced read-only with a *prefix* check on the boto3 method name
 * (`ALLOWED_PREFIXES = ("describe_", "list_", "get_", "batch_get_")`).
 *
 * The TypeScript port is **stricter**: instead of allowing any command whose
 * name happens to start with a read verb, it keeps an explicit allowlist of the
 * exact SDK command constructors actually used by the audit. Anything else is
 * rejected before it can reach AWS.
 *
 * `guardClient()` wraps a client in a Proxy so that *every* `send()` — including
 * the ones made internally by SDK paginators — passes through the allowlist.
 * This mirrors `safe_call()` / `paginate()` without depending on class names
 * (which bundlers may mangle).
 */
import {
	DescribeAddressesCommand,
	DescribeImagesCommand,
	DescribeInstancesCommand,
	DescribeNatGatewaysCommand,
	DescribeSnapshotsCommand,
	DescribeVolumesCommand,
	DescribeVpnConnectionsCommand,
} from "@aws-sdk/client-ec2";
import { DescribeLoadBalancersCommand as DescribeClassicLoadBalancersCommand } from "@aws-sdk/client-elastic-load-balancing";
import {
	DescribeLoadBalancersCommand,
	DescribeTargetGroupsCommand,
	DescribeTargetHealthCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import {
	DescribeClusterCommand,
	DescribeNodegroupCommand,
	ListClustersCommand,
	ListNodegroupsCommand,
} from "@aws-sdk/client-eks";
import { DescribeSecretCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeAlarmsCommand, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import {
	GetBucketLifecycleConfigurationCommand,
	GetBucketVersioningCommand,
	ListBucketsCommand,
} from "@aws-sdk/client-s3";
import { GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";

/** Exact command constructors the audit is permitted to send. */
export const ALLOWED_COMMANDS: ReadonlySet<unknown> = new Set<unknown>([
	// EC2
	DescribeInstancesCommand,
	DescribeVolumesCommand,
	DescribeAddressesCommand,
	DescribeSnapshotsCommand,
	DescribeImagesCommand,
	DescribeNatGatewaysCommand,
	DescribeVpnConnectionsCommand,
	// ELB v2 (ALB/NLB)
	DescribeLoadBalancersCommand,
	DescribeTargetGroupsCommand,
	DescribeTargetHealthCommand,
	// ELB classic
	DescribeClassicLoadBalancersCommand,
	// RDS
	DescribeDBInstancesCommand,
	// EKS
	ListClustersCommand,
	DescribeClusterCommand,
	ListNodegroupsCommand,
	DescribeNodegroupCommand,
	// Secrets Manager
	ListSecretsCommand,
	DescribeSecretCommand,
	// CloudWatch Logs + CloudWatch
	DescribeLogGroupsCommand,
	DescribeAlarmsCommand,
	GetMetricStatisticsCommand,
	// S3
	ListBucketsCommand,
	GetBucketLifecycleConfigurationCommand,
	GetBucketVersioningCommand,
	// Cost Explorer + STS
	GetCostAndUsageCommand,
	GetCallerIdentityCommand,
]);

/** The Python prefix rule, kept for documentation / parity reference. */
export const READ_ONLY_PREFIXES = ["describe_", "list_", "get_", "batch_get_"] as const;

/** The command's constructor name, only used for error messages. */
function commandName(command: unknown): string {
	const ctor = (command as { constructor?: { name?: string } } | null)?.constructor;
	return ctor?.name ?? "unknown";
}

export function isReadOnlyCommand(command: unknown): boolean {
	if (command === null || typeof command !== "object") return false;
	return ALLOWED_COMMANDS.has(command.constructor);
}

/** Throws unless `command` is on the read-only allowlist. */
export function assertReadOnly(command: unknown): void {
	if (!isReadOnlyCommand(command)) {
		throw new Error(
			`[READ-ONLY BLOCK] '${commandName(command)}' is not on the read-only allowlist. ` +
				`Only ${ALLOWED_COMMANDS.size} Describe/List/Get commands are permitted.`,
		);
	}
}

interface Sendable {
	send?: (command: unknown, options?: unknown) => unknown;
}

/**
 * Wrap a client (real SDK client, or a test double) so every `send()` is
 * validated against the allowlist. Paginators built on the guarded client are
 * therefore guarded too.
 */
export function guardClient<C extends object>(client: C): C {
	return new Proxy(client as C & Sendable, {
		get(target, prop, receiver) {
			if (prop === "send") {
				const send = target.send;
				if (typeof send !== "function") return undefined;
				return async (command: unknown, options?: unknown) => {
					assertReadOnly(command);
					return send.call(target, command, options);
				};
			}
			const value = Reflect.get(target, prop, receiver) as unknown;
			return typeof value === "function"
				? (value as (...a: unknown[]) => unknown).bind(target)
				: value;
		},
	}) as C;
}

/** Port of `audit_runner.py:29-35` — never reveals the secret part of a key. */
export function maskKey(accessKey?: string | null): string {
	if (!accessKey) return "(role-chain)";
	const ak = accessKey.trim();
	if (ak.length <= 4) return "****";
	return `AKIA****${ak.slice(-4)}`;
}
