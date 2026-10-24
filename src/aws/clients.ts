/**
 * AWS SDK v3 client factory — the TS equivalent of
 * `cost-optimization.py:40-42 _client()` + `make_session()`.
 *
 * Every client is wrapped by `guardClient()`, so all calls are validated against
 * the read-only allowlist. Credentials live in memory for the lifetime of the
 * request/workflow step only.
 *
 * Parity note: Python used `Config(connect_timeout=5, read_timeout=15,
 * retries={"max_attempts": 2})`. Workers cannot use `node:http` outbound sockets,
 * so we keep the SDK's fetch-based handler and port the retry count
 * (`maxAttempts: 2`). Per-request timeouts are left to the platform.
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
import { guardClient } from "./guard";

export interface AwsCredentials {
	accessKeyId?: string | null;
	secretAccessKey?: string | null;
	sessionToken?: string | null;
}

export interface Aws {
	region: string;
	ec2: EC2Client;
	elbv2: ElasticLoadBalancingV2Client;
	elb: ElasticLoadBalancingClient;
	rds: RDSClient;
	eks: EKSClient;
	secrets: SecretsManagerClient;
	logs: CloudWatchLogsClient;
	cw: CloudWatchClient;
	s3: S3Client;
	ce: CostExplorerClient;
	sts: STSClient;
}

/** Cost Explorer is a global (us-east-1) service. */
const CE_REGION = "us-east-1";

export function createAws(creds: AwsCredentials, region: string): Aws {
	const hasStatic = Boolean(creds.accessKeyId && creds.secretAccessKey);
	const credentials = hasStatic
		? {
				accessKeyId: creds.accessKeyId as string,
				secretAccessKey: creds.secretAccessKey as string,
				...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
			}
		: undefined;

	const base = { region, maxAttempts: 2, ...(credentials ? { credentials } : {}) };

	return {
		region,
		ec2: guardClient(new EC2Client(base)),
		elbv2: guardClient(new ElasticLoadBalancingV2Client(base)),
		elb: guardClient(new ElasticLoadBalancingClient(base)),
		rds: guardClient(new RDSClient(base)),
		eks: guardClient(new EKSClient(base)),
		secrets: guardClient(new SecretsManagerClient(base)),
		logs: guardClient(new CloudWatchLogsClient(base)),
		cw: guardClient(new CloudWatchClient(base)),
		s3: guardClient(new S3Client(base)),
		ce: guardClient(new CostExplorerClient({ ...base, region: CE_REGION })),
		sts: guardClient(new STSClient(base)),
	};
}
