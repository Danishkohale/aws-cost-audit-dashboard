/** RDS instances — port of `cost-optimization.py:231-261` `audit_rds()` (base scan). */
import { paginateDescribeDBInstances } from "@aws-sdk/client-rds";
import type { Finding } from "../../types";
import type { Aws } from "../clients";
import { addFinding } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, fetchList, sliceList } from "../range";
import { errMsg } from "../util";
import { f1, pyNum } from "../../report/format";
import { CATEGORY } from "../../rules/templates";

interface DbInstance {
	DBInstanceIdentifier?: string;
	DBInstanceClass?: string;
	DBInstanceStatus?: string;
	Engine?: string;
	MultiAZ?: boolean;
}

export async function auditRds(
	aws: Aws,
	findings: Finding[],
	days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let dbs: DbInstance[];
	try {
		dbs = await fetchList<DbInstance>(
			paginateDescribeDBInstances({ client: aws.rds }, {}) as AsyncIterable<unknown>,
			"DBInstances",
			range,
		);
	} catch (e) {
		addFinding(
			findings,
			"RDS",
			"-",
			CATEGORY.accessIssue,
			`describe_db_instances failed: ${errMsg(e)}`,
			0,
			"Grant rds:Describe*.",
		);
		return { next: null };
	}

	const { items, next } = sliceList(dbs, range);

	for (const d of items) {
		const did = d.DBInstanceIdentifier ?? "?";
		const cls = d.DBInstanceClass ?? "?";
		const status = d.DBInstanceStatus;
		const engine = d.Engine ?? "";
		const dims = [{ Name: "DBInstanceIdentifier", Value: did }];
		const cpu = await cwAvg(aws.cw, "AWS/RDS", "CPUUtilization", dims, days);
		const conns = await cwAvg(aws.cw, "AWS/RDS", "DatabaseConnections", dims, days);

		if (status === "stopped") {
			addFinding(
				findings,
				"RDS",
				did,
				CATEGORY.rdsStopped,
				`${cls} ${engine}, stopped. Storage + snapshots still billed.`,
				60,
				"Snapshot then delete if dev/test; stopped >7d auto-starts — don't rely on stop for savings.",
			);
			continue;
		}

		if (cpu !== null && cpu < 5 && (conns === null || conns < 5)) {
			addFinding(
				findings,
				"RDS",
				did,
				CATEGORY.rdsLowUse,
				`${cls}, CPU ${f1(cpu)}%, conns ${conns !== null ? pyNum(conns) : "n/a"} over ${days}d.`,
				120,
				"Downsize one class (e.g. db.m5.large→db.t3.medium), use Aurora Serverless v2 for spiky workloads, buy RI if steady.",
			);
		} else if (cpu !== null && cpu < 15) {
			addFinding(
				findings,
				"RDS",
				did,
				CATEGORY.rdsOversized,
				`${cls}, CPU ${f1(cpu)}% over ${days}d.`,
				60,
				"Rightsize down; enable Storage Autoscaling + Performance Insights first.",
			);
		}

		if (["m4", "r4", "t2"].some((x) => (cls ?? "").includes(x))) {
			addFinding(
				findings,
				"RDS",
				did,
				CATEGORY.rdsOldClass,
				`${cls} previous-gen.`,
				30,
				"Move to m6i/r6i/t3 (Graviton m7g where supported).",
			);
		}
		if (!d.MultiAZ && did.toLowerCase().includes("prod")) {
			addFinding(
				findings,
				"RDS",
				did,
				CATEGORY.rdsRisk,
				"Prod-named instance without MultiAZ.",
				0,
				"Keep MultiAZ for prod; save via RI instead of removing HA.",
			);
		}
	}

	return { next };
}
