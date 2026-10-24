/** VPC NAT/VPN — port of `cost-optimization.py:304-324` `audit_vpc()` (base scan). */
import { DescribeVpnConnectionsCommand, paginateDescribeNatGateways } from "@aws-sdk/client-ec2";
import type { Finding } from "../../types";
import type { Aws } from "../clients";
import { addFinding } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, fetchList, isFirst, sliceList } from "../range";
import { errMsg } from "../util";
import { CATEGORY } from "../../rules/templates";

export async function auditVpc(
	aws: Aws,
	findings: Finding[],
	days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	try {
		const ngws = await fetchList<{ State?: string; NatGatewayId?: string }>(
			paginateDescribeNatGateways({ client: aws.ec2 }, {}) as AsyncIterable<unknown>,
			"NatGateways",
			range,
		);
		const { items, next } = sliceList(ngws, range);

		for (const n of items) {
			if (n.State !== "available") continue;
			const nid = n.NatGatewayId ?? "?";
			const b = await cwAvg(
				aws.cw,
				"AWS/NATGateway",
				"BytesOutToDestination",
				[{ Name: "NatGatewayId", Value: nid }],
				days,
				"Sum",
			);
			if (b !== null && b < 1e9) {
				// <1GB in period
				addFinding(
					findings,
					"VPC",
					nid,
					CATEGORY.vpcNatIdle,
					`Available but <1GB/${days}d. Base ~$32/mo + per-GB.`,
					32,
					"Remove if AZ has no private subnets needing egress; share one NAT per AZ; consider VPC endpoints for S3/DynamoDB.",
				);
			}
		}

		if (isFirst(range)) {
			const vpns = (await aws.ec2.send(new DescribeVpnConnectionsCommand({}))).VpnConnections ?? [];
			for (const v of vpns) {
				if (v.State !== "available") {
					addFinding(
						findings,
						"VPC",
						v.VpnConnectionId ?? "?",
						CATEGORY.vpcVpnUnused,
						`State ${v.State}. ~$36/conn/mo when available.`,
						36,
						"Delete unused VPN; use Direct Connect/VPN only where needed.",
					);
				}
			}
		}

		return { next };
	} catch (e) {
		addFinding(
			findings,
			"VPC",
			"-",
			CATEGORY.accessIssue,
			`VPC audit failed: ${errMsg(e)}`,
			0,
			"Grant ec2:Describe*.",
		);
		return { next: null };
	}
}
