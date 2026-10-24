/** Deep RDS rows — port of `detailed_audit.py:232-288` `detail_rds()`. */
import { paginateDescribeDBInstances } from "@aws-sdk/client-rds";
import type { Finding, FindingMeta } from "../../types";
import type { Aws } from "../clients";
import { addDetail } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, fetchList, sliceList } from "../range";
import { ageDays, errMsg, round2 } from "../util";
import { f0, f1, pyBool, pyNum } from "../../report/format";
import { CATEGORY } from "../../rules/templates";
import { RDS_PRICE_DEFAULT, RDS_PRICE_MO } from "../../rules/pricing";

interface DbInstance {
	DBInstanceIdentifier?: string;
	DBInstanceClass?: string;
	Engine?: string;
	EngineVersion?: string;
	DBInstanceStatus?: string;
	MultiAZ?: boolean;
	AllocatedStorage?: number;
	StorageType?: string;
	InstanceCreateTime?: Date | string;
	BackupRetentionPeriod?: number;
}

export async function detailRds(
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
		addDetail(
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
		try {
			const cls = d.DBInstanceClass ?? "?";
			const engine = `${d.Engine ?? "?"} ${d.EngineVersion ?? ""}`.trim();
			const status = d.DBInstanceStatus;
			const maz = d.MultiAZ ?? false;
			const storage = d.AllocatedStorage ?? 0;
			const stype = d.StorageType ?? "?";
			const age = ageDays(d.InstanceCreateTime);
			const backup = d.BackupRetentionPeriod ?? 0;
			const base = (RDS_PRICE_MO[cls] ?? RDS_PRICE_DEFAULT) * (maz ? 2 : 1);

			const dim = [{ Name: "DBInstanceIdentifier", Value: did }];
			const cpu = await cwAvg(aws.cw, "AWS/RDS", "CPUUtilization", dim, days);
			const cpumax = await cwAvg(aws.cw, "AWS/RDS", "CPUUtilization", dim, days, "Maximum");
			const conns = await cwAvg(aws.cw, "AWS/RDS", "DatabaseConnections", dim, days);
			const free = await cwAvg(aws.cw, "AWS/RDS", "FreeStorageSpace", dim, days, "Minimum");
			const riops = await cwAvg(aws.cw, "AWS/RDS", "ReadIOPS", dim, days);
			const wiops = await cwAvg(aws.cw, "AWS/RDS", "WriteIOPS", dim, days);

			const io =
				(cpu !== null ? `CPU avg ${f1(cpu)}%/max ${f1(cpumax)}%` : "CPU n/a") +
				(conns !== null ? `, conns avg ${f0(conns)}` : "") +
				(riops !== null ? `, I/O read ${f0(riops)}/write ${f0(wiops)} IOPS` : "") +
				(free !== null ? `, free storage ${f1((free || 0) / 1e9)}GB` : "");

			const meta: FindingMeta = {
				class: cls,
				engine,
				status: status ?? null,
				multiaz: maz,
				storage_gb: storage,
				storage_type: stype,
				age_days: age,
				cpu_avg: cpu,
				conns_avg: conns,
				backup_days: backup,
				base_cost_mo: base,
			};

			if (status === "stopped") {
				addDetail(
					findings,
					"RDS",
					did,
					CATEGORY.rdsStopped,
					`${cls} ${engine}, MultiAZ=${pyBool(maz)}, ${storage}GB ${stype}, age ${age}d. I/O: ${io}. Storage+snapshots still billed ~$${pyNum(round2(storage * 0.1))}/mo.`,
					round2(base * 0.7),
					"Snapshot then delete if dev/test; stopped >7d auto-starts.",
					meta,
				);
			} else if (cpu !== null && cpu < 5 && (conns === null || conns < 5)) {
				addDetail(
					findings,
					"RDS",
					did,
					CATEGORY.rdsLowUse,
					`${cls} ${engine}, MultiAZ=${pyBool(maz)}, ${storage}GB ${stype}. I/O: ${io}. Paying ~$${base}/mo.`,
					round2(base * 0.6),
					"Downsize one class, Aurora Serverless v2 for spiky, RI if steady.",
					meta,
				);
			} else if (cpu !== null && cpu < 15) {
				addDetail(
					findings,
					"RDS",
					did,
					CATEGORY.rdsOversized,
					`${cls} ${engine}, ${storage}GB ${stype}. I/O: ${io}. ~$${base}/mo.`,
					round2(base * 0.4),
					"Rightsize down; enable Storage Autoscaling + PI first.",
					meta,
				);
			} else {
				addDetail(
					findings,
					"RDS",
					did,
					status === "available" ? CATEGORY.rdsHealthy : `State — ${status}`,
					`${cls} ${engine}, MultiAZ=${pyBool(maz)}, ${storage}GB ${stype}, backup ${backup}d. I/O: ${io}. ~$${base}/mo.`,
					0,
					"No action; buy RI if steady-state.",
					meta,
				);
			}

			if (stype === "gp2") {
				addDetail(
					findings,
					"RDS",
					did,
					CATEGORY.rdsGp2,
					`${storage}GB gp2. gp3/autoscaling cheaper.`,
					round2(storage * 0.02),
					"Modify to gp3 + enable Storage Autoscaling.",
				);
			}
		} catch {
			continue;
		}
	}

	return { next };
}
