/** Deep VPC rows — port of `detailed_audit.py:395-440` `detail_vpc()`. */
import { DescribeVpnConnectionsCommand, paginateDescribeNatGateways } from "@aws-sdk/client-ec2";
import type { Finding, FindingMeta } from "../../types";
import type { Aws } from "../clients";
import { addDetail } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, fetchList, isFirst, sliceList } from "../range";
import { ageDays, errMsg, round2 } from "../util";
import { f1 } from "../../report/format";
import { CATEGORY } from "../../rules/templates";

export async function detailVpc(
	aws: Aws,
	findings: Finding[],
	days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let ngws: {
		State?: string;
		NatGatewayId?: string;
		SubnetId?: string;
		CreateTime?: Date | string;
	}[];
	try {
		ngws = await fetchList(
			paginateDescribeNatGateways({ client: aws.ec2 }, {}) as AsyncIterable<unknown>,
			"NatGateways",
			range,
		);
	} catch (e) {
		addDetail(
			findings,
			"VPC",
			"-",
			CATEGORY.accessIssue,
			`describe_nat_gateways failed: ${errMsg(e)}`,
			0,
			"Grant ec2:Describe*.",
		);
		return { next: null };
	}

	const { items, next } = sliceList(ngws, range);

	for (const n of items) {
		const nid = n.NatGatewayId ?? "?";
		try {
			if (n.State !== "available") continue;
			const age = ageDays(n.CreateTime);
			const az = n.SubnetId ?? "?";
			const dim = [{ Name: "NatGatewayId", Value: nid }];
			const outB = await cwAvg(aws.cw, "AWS/NATGateway", "BytesOutToDestination", dim, days, "Sum");
			const inB = await cwAvg(aws.cw, "AWS/NATGateway", "BytesInFromSource", dim, days, "Sum");
			const outGb = outB !== null ? (outB || 0) / 1e9 : null;

			const io =
				(outB !== null
					? `out ${f1(outGb)}GB + in ${f1((inB || 0) / 1e9)}GB per ${days}d`
					: "traffic metrics unavailable") + `, age ${age}d, subnet ${az}`;

			const meta: FindingMeta = {
				age_days: age,
				out_gb: outGb !== null ? round2(outGb) : null,
			};

			if (outGb !== null && outGb < 1) {
				addDetail(
					findings,
					"VPC",
					nid,
					CATEGORY.vpcNatIdle,
					`Available. I/O: ${io}. Base ~$32/mo + per-GB data processing.`,
					32,
					"Remove if AZ has no private subnets needing egress; share one NAT/AZ; add S3/DynamoDB VPC endpoints.",
					meta,
				);
			} else if (outGb !== null && outGb < 50) {
				addDetail(
					findings,
					"VPC",
					nid,
					CATEGORY.vpcNatReview,
					`I/O: ${io}. Base $32/mo dominates at this volume.`,
					10,
					"Consolidate AZs or use VPC endpoints for S3/DynamoDB.",
					meta,
				);
			}
		} catch {
			continue;
		}
	}

	if (isFirst(range)) {
		try {
			const vpns = (await aws.ec2.send(new DescribeVpnConnectionsCommand({}))).VpnConnections ?? [];
			for (const v of vpns) {
				const vid = v.VpnConnectionId ?? "?";
				const state = v.State;
				const tunnels = v.VgwTelemetry ?? [];
				const up = tunnels.filter((t) => t.Status === "UP").length;
				if (state !== "available" || up === 0) {
					addDetail(
						findings,
						"VPC",
						vid,
						CATEGORY.vpcVpnUnused,
						`State ${state}, tunnels UP ${up}/${tunnels.length}. ~$36/mo when available.`,
						36,
						"Delete unused VPN connection.",
						{ state: state ?? null, tunnels_up: up },
					);
				}
			}
		} catch {
			/* VPN optional */
		}
	}

	return { next };
}
