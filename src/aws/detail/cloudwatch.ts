/** Deep CloudWatch rows — port of `detailed_audit.py:355-391` `detail_cloudwatch()`. */
import { paginateDescribeLogGroups } from "@aws-sdk/client-cloudwatch-logs";
import type { Finding, FindingMeta } from "../../types";
import type { Aws } from "../clients";
import { addDetail } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, fetchAllBounded, isFirst } from "../range";
import { errMsg, round2 } from "../util";
import { comma, f1, f2, pyNum } from "../../report/format";
import { CATEGORY } from "../../rules/templates";
import { CW_INGEST_GB, CW_STORE_GB_MO } from "../../rules/pricing";

interface LogGroup {
	logGroupName?: string;
	retentionInDays?: number;
	storedBytes?: number;
}

/** Python caps the deep layer at 80 groups; beyond that it emits a truncation row. */
const CAP = 80;

/** Hard ceiling on how many log groups the deep layer will even list. */
const MAX_GROUPS = 500;

export async function detailCloudwatch(
	aws: Aws,
	findings: Finding[],
	days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let groups: LogGroup[];
	try {
		// Listed in full (bounded) rather than sliced, so the "showing N of M" row
		// carries the same total whether the step runs chunked or in one pass.
		groups = await fetchAllBounded<LogGroup>(
			paginateDescribeLogGroups({ client: aws.logs }, {}) as AsyncIterable<unknown>,
			"logGroups",
			MAX_GROUPS,
		);
	} catch (e) {
		addDetail(
			findings,
			"CloudWatch",
			"-",
			CATEGORY.accessIssue,
			`describe_log_groups failed: ${errMsg(e)}`,
			0,
			"Grant logs:Describe*.",
		);
		return { next: null };
	}

	const capped = groups.slice(0, CAP);
	const offset = range?.offset ?? 0;
	const limit = range?.limit ?? Infinity;
	const items = capped.slice(offset, offset + limit);
	const consumed = offset + items.length;
	const next = consumed < capped.length ? consumed : null;

	for (const g of items) {
		const name = g.logGroupName ?? "?";
		try {
			const ret = g.retentionInDays;
			const stored = g.storedBytes ?? 0;
			const storedGb = stored / 1e9;
			const dim = [{ Name: "LogGroupName", Value: name }];
			const ingest = await cwAvg(aws.cw, "AWS/Logs", "IncomingBytes", dim, days, "Sum");
			const events = await cwAvg(aws.cw, "AWS/Logs", "IncomingLogEvents", dim, days, "Sum");
			const ingestGbD = ingest !== null ? (ingest || 0) / 1e9 / days : null;

			const io =
				(ingest !== null
					? `ingest ${f2(ingestGbD)} GB/day, ${comma(events ?? 0)} events/${days}d`
					: "ingestion metrics unavailable") +
				`, stored ${f1(storedGb)}GB, retention ${ret || "NeverExpire"}`;

			const ingestCost = round2((ingestGbD || 0) * 30 * CW_INGEST_GB);

			const meta: FindingMeta = {
				stored_gb: round2(storedGb),
				retention_days: ret ?? null,
				ingest_gb_day: ingestGbD !== null ? Math.round(ingestGbD * 1000) / 1000 : null,
				est_ingest_mo: ingestCost,
			};

			if (ret === undefined && storedGb >= 1) {
				addDetail(
					findings,
					"CloudWatch",
					name,
					CATEGORY.cwNeverExpire,
					`I/O: ${io}. Ingest ~$${pyNum(ingestCost)}/mo + storage ~$${pyNum(round2(storedGb * CW_STORE_GB_MO))}/mo.`,
					round2(Math.min(storedGb * CW_STORE_GB_MO * 0.7 + ingestCost * 0.2, 150)),
					"Set retention 14-90d; export to S3 Glacier for compliance; cut DEBUG logging.",
					meta,
				);
			} else if (ingestGbD && ingestGbD > 5) {
				addDetail(
					findings,
					"CloudWatch",
					name,
					CATEGORY.cwHighIngest,
					`I/O: ${io}. Ingest ~$${pyNum(ingestCost)}/mo dominates.`,
					round2(ingestCost * 0.3),
					"Sample/debug at lower verbosity; use metric filters + S3 export.",
					meta,
				);
			}
		} catch {
			continue;
		}
	}

	if (isFirst(range) && groups.length > CAP) {
		addDetail(
			findings,
			"CloudWatch",
			`${groups.length} log groups`,
			CATEGORY.cwTruncated,
			`Showing ${CAP}/${groups.length}.`,
			0,
			"Narrow by prefix for full detail.",
		);
	}

	return { next };
}
