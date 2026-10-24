/** CloudWatch logs + alarms — port of `cost-optimization.py:381-399` `audit_cloudwatch()`. */
import { paginateDescribeLogGroups } from "@aws-sdk/client-cloudwatch-logs";
import { paginateDescribeAlarms } from "@aws-sdk/client-cloudwatch";
import type { Finding } from "../../types";
import type { Aws } from "../clients";
import { addFinding } from "../findings";
import { type ScanRange, type ScanResult, fetchList, isFirst, sliceList } from "../range";
import { errMsg } from "../util";
import { f1 } from "../../report/format";
import { CATEGORY } from "../../rules/templates";

interface LogGroup {
	logGroupName?: string;
	retentionInDays?: number;
	storedBytes?: number;
}

export async function auditCloudwatch(
	aws: Aws,
	findings: Finding[],
	_days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	try {
		const groups = await fetchList<LogGroup>(
			paginateDescribeLogGroups({ client: aws.logs }, {}) as AsyncIterable<unknown>,
			"logGroups",
			range,
		);
		const { items, next } = sliceList(groups, range);

		for (const g of items) {
			const name = g.logGroupName ?? "?";
			const ret = g.retentionInDays;
			const stored = g.storedBytes ?? 0;
			if (ret === undefined && stored && stored > 1e9) {
				addFinding(
					findings,
					"CloudWatch",
					name,
					CATEGORY.cwNeverExpire,
					`${f1(stored / 1e9)}GB stored, retention=NeverExpire ($0.03/GB ingest + $0.03/GB-mo).`,
					10,
					"Set retention 14-90d; export to S3 Glacier for compliance; reduce DEBUG logging.",
				);
			}
		}

		if (isFirst(range)) {
			const alarms = await fetchList<{ AlarmName?: string; StateValue?: string }>(
				paginateDescribeAlarms({ client: aws.cw }, {}) as AsyncIterable<unknown>,
				"MetricAlarms",
			);
			const bad = alarms
				.filter((a) => a.StateValue === "INSUFFICIENT_DATA")
				.map((a) => a.AlarmName ?? "?");
			if (bad.length > 0) {
				addFinding(
					findings,
					"CloudWatch",
					`${bad.length} alarms`,
					CATEGORY.cwDeadAlarms,
					`${bad.length} alarms INSUFFICIENT_DATA (e.g. ${bad[0]}).`,
					2,
					"Delete/fix dead alarms; consolidate with composite alarms.",
				);
			}
		}

		return { next };
	} catch (e) {
		addFinding(
			findings,
			"CloudWatch",
			"-",
			CATEGORY.accessIssue,
			`CloudWatch audit failed: ${errMsg(e)}`,
			0,
			"Grant logs:Describe* + cloudwatch:Describe*.",
		);
		return { next: null };
	}
}
