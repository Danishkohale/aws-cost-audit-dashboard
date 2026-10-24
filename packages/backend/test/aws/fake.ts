/**
 * Fake AWS harness for unit tests.
 *
 * Builds real SDK client instances (so paginator `instanceof` checks pass) with a
 * stubbed `send()` that dispatches to canned handlers keyed by the command class
 * name. Each client is then wrapped with `guardClient()`, so the same read-only
 * allowlist that protects production also protects the tests: a scanner that
 * tried to send a write command would fail here too.
 */
import { EC2Client } from "@aws-sdk/client-ec2";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { ElasticLoadBalancingClient } from "@aws-sdk/client-elastic-load-balancing";
import { RDSClient } from "@aws-sdk/client-rds";
import { EKSClient } from "@aws-sdk/client-eks";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { S3Client } from "@aws-sdk/client-s3";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { STSClient } from "@aws-sdk/client-sts";
import type { Aws } from "../../src/aws/clients";
import { guardClient } from "../../src/aws/guard";

type Handler = (input: Record<string, unknown>) => unknown;
export type Dispatch = Record<string, Handler>;
export type ServiceKey =
	"ec2" | "elbv2" | "elb" | "rds" | "eks" | "secrets" | "logs" | "cw" | "s3" | "ce" | "sts";

interface FakeCommand {
	constructor: { name: string };
	input: Record<string, unknown>;
}

interface AnyClient {
	send: (command: FakeCommand) => Promise<unknown>;
}

type ClientCtor = new (config: object) => AnyClient;

const REGION = "ap-south-1";
const CREDS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "secret" };

function makeClient(
	Ctor: ClientCtor,
	dispatch: Dispatch,
	onSend?: (name: string) => void,
): AnyClient {
	const client = new Ctor({ region: REGION, credentials: CREDS });
	client.send = async (command: FakeCommand): Promise<unknown> => {
		onSend?.(command.constructor.name);
		const handler = dispatch[command.constructor.name];
		if (!handler) throw new Error(`no fake handler for ${command.constructor.name}`);
		return handler(command.input);
	};
	return guardClient(client);
}

function unexpected(): Dispatch {
	return new Proxy({} as Dispatch, {
		get: () => (): never => {
			throw new Error("unexpected AWS call in this test");
		},
	});
}

export function fakeAws(
	overrides: Partial<Record<ServiceKey, Dispatch>> = {},
	onSend?: (name: string) => void,
): Aws {
	const mk = (key: ServiceKey, Ctor: ClientCtor) =>
		makeClient(Ctor, overrides[key] ?? unexpected(), onSend);
	return {
		region: REGION,
		ec2: mk("ec2", EC2Client as unknown as ClientCtor),
		elbv2: mk("elbv2", ElasticLoadBalancingV2Client as unknown as ClientCtor),
		elb: mk("elb", ElasticLoadBalancingClient as unknown as ClientCtor),
		rds: mk("rds", RDSClient as unknown as ClientCtor),
		eks: mk("eks", EKSClient as unknown as ClientCtor),
		secrets: mk("secrets", SecretsManagerClient as unknown as ClientCtor),
		logs: mk("logs", CloudWatchLogsClient as unknown as ClientCtor),
		cw: mk("cw", CloudWatchClient as unknown as ClientCtor),
		s3: mk("s3", S3Client as unknown as ClientCtor),
		ce: mk("ce", CostExplorerClient as unknown as ClientCtor),
		sts: mk("sts", STSClient as unknown as ClientCtor),
	} as unknown as Aws;
}

/** A CloudWatch dispatcher keyed by `"<Namespace>|<MetricName>"`. */
export function cwDispatch(
	byMetric: Record<string, (input: Record<string, unknown>) => unknown>,
): Dispatch {
	return {
		GetMetricStatisticsCommand: (input) => {
			const key = `${input.Namespace}|${input.MetricName}`;
			const handler = byMetric[key];
			return handler ? handler(input) : { Datapoints: [] };
		},
	};
}

export function dims(input: Record<string, unknown>, name: string): string | undefined {
	const list = (input.Dimensions ?? []) as { Name: string; Value: string }[];
	return list.find((d) => d.Name === name)?.Value;
}
