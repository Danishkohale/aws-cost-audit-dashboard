/** EBS / EIP / snapshots — port of `cost-optimization.py:208-229` `audit_ec2_other()`. */
import {
	DescribeAddressesCommand,
	paginateDescribeSnapshots,
	paginateDescribeVolumes,
} from "@aws-sdk/client-ec2";
import type { Finding } from "../../types";
import type { Aws } from "../clients";
import { addFinding } from "../findings";
import {
	type ScanRange,
	type ScanResult,
	fetchAllBounded,
	fetchList,
	isFirst,
	sliceList,
} from "../range";
import { errMsg, round2 } from "../util";
import { f0 } from "../../report/format";
import { CATEGORY } from "../../rules/templates";

interface Vol {
	State?: string;
	VolumeId?: string;
	Size?: number;
	VolumeType?: string;
	AvailabilityZone?: string;
}

export async function auditEc2Other(
	aws: Aws,
	findings: Finding[],
	_days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	const first = isFirst(range);
	try {
		const vols = await fetchList<Vol>(
			paginateDescribeVolumes({ client: aws.ec2 }, {}) as AsyncIterable<unknown>,
			"Volumes",
			range,
		);
		const { items, next } = sliceList(vols, range);

		for (const v of items) {
			if (v.State === "available") {
				const size = v.Size ?? 0;
				addFinding(
					findings,
					"EC2-Other",
					v.VolumeId ?? "?",
					CATEGORY.ec2OtherUnattachedEbs,
					`${size}GB ${v.VolumeType ?? "?"} in ${v.AvailabilityZone ?? "?"}. ~$${f0(size * 0.08)}/mo.`,
					round2(size * 0.08),
					"Snapshot then delete unattached volume; add lifecycle policy.",
				);
			}
		}

		// EIPs and snapshots are whole-account totals, not per-resource loops, so
		// they only run on the first chunk.
		if (first) {
			const addrs = (await aws.ec2.send(new DescribeAddressesCommand({}))).Addresses ?? [];
			for (const a of addrs) {
				if (!a.AssociationId) {
					addFinding(
						findings,
						"EC2-Other",
						a.PublicIp ?? a.AllocationId ?? "?",
						CATEGORY.ec2OtherEip,
						"Elastic IP with no instance/NAT — $3.65/mo each.",
						3.65,
						"Re-associate or release EIP.",
					);
				}
			}

			const snaps = await fetchAllBounded<unknown>(
				paginateDescribeSnapshots(
					{ client: aws.ec2 },
					{ OwnerIds: ["self"] },
				) as AsyncIterable<unknown>,
				"Snapshots",
			);
			if (snaps.length > 50) {
				addFinding(
					findings,
					"EC2-Other",
					`${snaps.length} snapshots`,
					CATEGORY.snapBaseSprawl,
					`${snaps.length} self-owned snapshots; old ones billed per GB-mo.`,
					20,
					"Delete snapshots >90d without AMI; use DLM retention.",
				);
			}
		}

		return { next };
	} catch (e) {
		addFinding(
			findings,
			"EC2-Other",
			"-",
			CATEGORY.accessIssue,
			`EC2-Other audit failed: ${errMsg(e)}`,
			0,
			"Grant ec2:Describe*.",
		);
		return { next: null };
	}
}
