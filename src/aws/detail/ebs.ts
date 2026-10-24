/** Deep EBS rows — port of `detailed_audit.py:129-175` `detail_ebs()`. */
import { paginateDescribeVolumes } from "@aws-sdk/client-ec2";
import type { Finding, FindingMeta } from "../../types";
import type { Aws } from "../clients";
import { addDetail } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, fetchList, sliceList } from "../range";
import { ageDays, errMsg, round2 } from "../util";
import { f0, pyNum } from "../../report/format";
import { CATEGORY } from "../../rules/templates";
import { EBS_GB_DEFAULT, EBS_GB_MO } from "../../rules/pricing";

interface Volume {
	VolumeId?: string;
	Size?: number;
	VolumeType?: string;
	State?: string;
	Attachments?: { InstanceId?: string }[];
	CreateTime?: Date | string;
	AvailabilityZone?: string;
}

export async function detailEbs(
	aws: Aws,
	findings: Finding[],
	_days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let vols: Volume[];
	try {
		vols = await fetchList<Volume>(
			paginateDescribeVolumes({ client: aws.ec2 }, {}) as AsyncIterable<unknown>,
			"Volumes",
			range,
		);
	} catch (e) {
		addDetail(
			findings,
			"EBS",
			"-",
			CATEGORY.accessIssue,
			`describe_volumes failed: ${errMsg(e)}`,
			0,
			"Grant ec2:Describe*.",
		);
		return { next: null };
	}

	const { items, next } = sliceList(vols, range);

	for (const v of items) {
		const vid = v.VolumeId ?? "?";
		try {
			const size = v.Size ?? 0;
			const vtype = v.VolumeType ?? "gp3";
			const state = v.State;
			const att = v.Attachments ?? [];
			const attached = att.length > 0 ? (att[0].InstanceId ?? null) : null;
			const age = ageDays(v.CreateTime);
			const az = v.AvailabilityZone ?? "?";
			const rate = EBS_GB_MO[vtype] ?? EBS_GB_DEFAULT;
			const cost = round2(size * rate);

			const dim = [{ Name: "VolumeId", Value: vid }];
			const rOps = await cwAvg(aws.cw, "AWS/EBS", "VolumeReadOps", dim, 14, "Sum");
			const wOps = await cwAvg(aws.cw, "AWS/EBS", "VolumeWriteOps", dim, 14, "Sum");
			await cwAvg(aws.cw, "AWS/EBS", "VolumeIdleTime", dim, 14, "Sum");

			const io =
				rOps !== null
					? `read ${f0(rOps)} + write ${f0(wOps ?? 0)} ops/14d`
					: "I/O metrics unavailable";

			const meta: FindingMeta = {
				size_gb: size,
				type: vtype,
				state: state ?? null,
				attached_to: attached,
				age_days: age,
				az,
				read_ops_14d: rOps,
				write_ops_14d: wOps,
				est_cost_mo: cost,
			};

			if (state === "available") {
				addDetail(
					findings,
					"EBS",
					vid,
					CATEGORY.ebsUnattached,
					`${size}GB ${vtype} in ${az}, age ${age}d. I/O: ${io}. Costs ~$${pyNum(cost)}/mo for nothing.`,
					cost,
					"Snapshot then delete; add DLM retention.",
					meta,
				);
			} else if (rOps !== null && rOps + (wOps ?? 0) < 100) {
				addDetail(
					findings,
					"EBS",
					vid,
					CATEGORY.ebsLowIo,
					`${size}GB ${vtype} attached to ${attached}, age ${age}d. I/O: ${io}. ~$${pyNum(cost)}/mo.`,
					round2(cost * 0.5),
					"Downsize volume, move cold data to S3/EFS, or snapshot + shrink.",
					meta,
				);
			} else if (vtype === "gp2") {
				addDetail(
					findings,
					"EBS",
					vid,
					CATEGORY.ebsGp2,
					`${size}GB gp2 attached to ${attached ?? "—"}. I/O: ${io}. gp3 is ~20% cheaper + tunable IOPS.`,
					round2(cost * 0.2),
					"Modify volume gp2→gp3 (online, no downtime).",
					meta,
				);
			} else {
				addDetail(
					findings,
					"EBS",
					vid,
					CATEGORY.ebsInUse,
					`${size}GB ${vtype} attached to ${attached}, age ${age}d. I/O: ${io}. ~$${pyNum(cost)}/mo.`,
					0,
					"No action.",
					meta,
				);
			}
		} catch {
			continue;
		}
	}

	return { next };
}
