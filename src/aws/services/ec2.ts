/** EC2 instances — port of `cost-optimization.py:174-206` `audit_ec2()` (base scan). */
import { DescribeInstancesCommand, type DescribeInstancesCommandOutput } from "@aws-sdk/client-ec2";
import type { Finding } from "../../types";
import type { Aws } from "../clients";
import { addFinding } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, sliceList } from "../range";
import { errMsg } from "../util";
import { f1 } from "../../report/format";
import { CATEGORY } from "../../rules/templates";

export async function auditEc2(
	aws: Aws,
	findings: Finding[],
	days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let res: DescribeInstancesCommandOutput;
	try {
		res = await aws.ec2.send(new DescribeInstancesCommand({}));
	} catch (e) {
		addFinding(
			findings,
			"EC2-Instances",
			"-",
			CATEGORY.accessIssue,
			`describe_instances failed: ${errMsg(e)}`,
			0,
			"Grant ec2:Describe*.",
		);
		return { next: null };
	}

	const instances = (res.Reservations ?? []).flatMap((r) => r.Instances ?? []);
	const { items, next } = sliceList(instances, range);

	for (const i of items) {
		const iid = i.InstanceId ?? "?";
		const state = i.State?.Name;
		const itype = i.InstanceType ?? "?";
		const launch = i.LaunchTime;
		const ageD = launch ? Math.floor((Date.now() - new Date(launch).getTime()) / 86_400_000) : 0;

		if (state === "stopped") {
			addFinding(
				findings,
				"EC2-Instances",
				iid,
				CATEGORY.ec2Stopped,
				`${itype}, stopped, age ${ageD}d. EBS still billed.`,
				30,
				"Terminate if unneeded (snapshot first) or start/rightsize. Stopped instances still pay EBS.",
			);
			continue;
		}
		if (state !== "running") continue;

		const cpu = await cwAvg(
			aws.cw,
			"AWS/EC2",
			"CPUUtilization",
			[{ Name: "InstanceId", Value: iid }],
			days,
		);
		if (cpu !== null && cpu < 5) {
			addFinding(
				findings,
				"EC2-Instances",
				iid,
				CATEGORY.ec2LowCpu,
				`${itype}, running ${ageD}d, avg CPU ${f1(cpu)}% over ${days}d.`,
				50,
				"Downsize (e.g. t3→t3.small/nano), schedule stop nights/weekends, or use Savings Plan.",
			);
		} else if (cpu !== null && cpu < 15) {
			addFinding(
				findings,
				"EC2-Instances",
				iid,
				CATEGORY.ec2Underutilized,
				`${itype}, avg CPU ${f1(cpu)}% over ${days}d.`,
				25,
				"Rightsize one family down; check memory with CloudWatch Agent.",
			);
		}
		if (
			itype.startsWith("t2.") ||
			itype.startsWith("m4.") ||
			itype.startsWith("c4.") ||
			itype.startsWith("r4.")
		) {
			addFinding(
				findings,
				"EC2-Instances",
				iid,
				CATEGORY.ec2OldGen,
				`${itype} is previous-gen; ~10-20% pricier than t3/m5 equivalent.`,
				15,
				`Migrate ${itype} → current gen (t3/m6i) in a maintenance window.`,
			);
		}
	}

	return { next };
}
