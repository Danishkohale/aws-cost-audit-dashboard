/** Deep EC2 rows — port of `detailed_audit.py:74-125` `detail_ec2()`. */
import { DescribeInstancesCommand, type DescribeInstancesCommandOutput } from "@aws-sdk/client-ec2";
import type { Finding, FindingMeta } from "../../types";
import type { Aws } from "../clients";
import { addDetail } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, sliceList } from "../range";
import { ageDays, errMsg } from "../util";
import { f1, round2 } from "../../report/format";
import { CATEGORY } from "../../rules/templates";
import { EC2_PRICE_MO, EC2_PRICE_DEFAULT } from "../../rules/pricing";

export async function detailEc2(
	aws: Aws,
	findings: Finding[],
	days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let res: DescribeInstancesCommandOutput;
	try {
		res = await aws.ec2.send(new DescribeInstancesCommand({}));
	} catch (e) {
		addDetail(
			findings,
			"EC2",
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
		try {
			const state = i.State?.Name;
			const itype = i.InstanceType ?? "?";
			const az = i.Placement?.AvailabilityZone ?? "?";
			const age = ageDays(i.LaunchTime);
			const base = EC2_PRICE_MO[itype] ?? EC2_PRICE_DEFAULT;
			const dim = [{ Name: "InstanceId", Value: iid }];
			const cpu = await cwAvg(aws.cw, "AWS/EC2", "CPUUtilization", dim, days);
			const cpumax = await cwAvg(aws.cw, "AWS/EC2", "CPUUtilization", dim, days, "Maximum");
			const netIn = await cwAvg(aws.cw, "AWS/EC2", "NetworkIn", dim, days, "Sum");
			const netOut = await cwAvg(aws.cw, "AWS/EC2", "NetworkOut", dim, days, "Sum");
			const nvol = (i.BlockDeviceMappings ?? []).length;

			const io =
				(cpu !== null ? `CPU avg ${f1(cpu)}% / max ${f1(cpumax)}%` : "CPU metrics unavailable") +
				(netIn !== null
					? `, net in/out ${f1((netIn || 0) / 1e9)}/${f1((netOut || 0) / 1e9)} GB/${days}d`
					: "");

			const meta: FindingMeta = {
				instance_type: itype,
				state: state ?? null,
				az,
				age_days: age,
				cpu_avg: cpu !== null ? Math.round(cpu * 10) / 10 : null,
				cpu_max: cpumax !== null ? Math.round(cpumax * 10) / 10 : null,
				net_in_gb: netIn !== null ? round2((netIn || 0) / 1e9) : null,
				net_out_gb: netOut !== null ? round2((netOut || 0) / 1e9) : null,
				volumes: nvol,
				base_cost_mo: base,
			};

			if (state === "stopped") {
				addDetail(
					findings,
					"EC2",
					iid,
					CATEGORY.ec2Stopped,
					`${itype} in ${az}, stopped, age ${age}d, ${nvol} EBS attached. I/O: ${io}. Full compute ~$${base}/mo wasted (EBS billed separately).`,
					base,
					"Terminate (snapshot first) or start/rightsize; don't park stopped long-term.",
					meta,
				);
			} else if (state === "running" && cpu !== null && cpu < 5) {
				addDetail(
					findings,
					"EC2",
					iid,
					CATEGORY.ec2LowCpu,
					`${itype} in ${az}, running ${age}d. I/O: ${io}. ~$${base}/mo compute for <5% CPU.`,
					round2(base * 0.6),
					"Downsize 1-2 steps, schedule stop nights/weekends, or Savings Plan.",
					meta,
				);
			} else if (state === "running" && cpu !== null && cpu < 15) {
				addDetail(
					findings,
					"EC2",
					iid,
					CATEGORY.ec2Underutilized,
					`${itype} in ${az}, running ${age}d. I/O: ${io}. Paying ~$${base}/mo.`,
					round2(base * 0.35),
					"Rightsize one family down; check memory via CloudWatch Agent.",
					meta,
				);
			} else if (state === "running") {
				addDetail(
					findings,
					"EC2",
					iid,
					(cpu || 0) >= 15 ? CATEGORY.ec2Healthy : CATEGORY.ec2NoMetrics,
					`${itype} in ${az}, running ${age}d. I/O: ${io}. Est. cost ~$${base}/mo.`,
					0,
					"No action; keep for baseline.",
					meta,
				);
			}
		} catch {
			continue;
		}
	}

	return { next };
}
