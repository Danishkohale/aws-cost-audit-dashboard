/**
 * Live Cost Explorer — port of `cost-optimization.py:132-171` `audit_live_cost()`.
 *
 * Groups spend by SERVICE, skips QuickSight, and maps AWS service names onto the
 * dashboard's fixed labels via `TARGET_KEYWORDS`.
 */
import {
	CostExplorerClient,
	GetCostAndUsageCommand,
	type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { round2 } from "../report/format";
import { errMsg, isoDate, minusDays } from "./util";

export const TARGET_KEYWORDS: Record<string, string[]> = {
	"EC2-Instances": ["elastic compute cloud - compute", "ec2-instances"],
	RDS: ["relational database service"],
	"EC2-Other": ["ec2 - other", "ec2-other"],
	ELB: ["elastic load balancing"],
	VPC: ["virtual private cloud"],
	EKS: ["container service for kubernetes", "elastic kubernetes service", "eks"],
	"Secrets Manager": ["secrets manager"],
	CloudWatch: ["cloudwatch"],
	S3: ["simple storage service"],
};

export interface LiveCost {
	cost: Record<string, number>;
	note: string;
}

/** `days` defaults to 30 — the Python callers use the default for Cost Explorer. */
export async function auditLiveCost(ce: CostExplorerClient, days = 30): Promise<LiveCost> {
	const end = new Date();
	const start = minusDays(end, days);

	let r: GetCostAndUsageCommandOutput;
	try {
		r = await ce.send(
			new GetCostAndUsageCommand({
				TimePeriod: { Start: isoDate(start), End: isoDate(end) },
				Granularity: "MONTHLY",
				Metrics: ["UnblendedCost"],
				GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
			}),
		);
	} catch (e) {
		return {
			cost: {},
			note: `Cost Explorer unavailable: ${errMsg(e)}. Check ce:GetCostAndUsage permission. Continuing with config-only audit.`,
		};
	}

	const out: Record<string, number> = {};
	for (const block of r.ResultsByTime ?? []) {
		for (const g of block.Groups ?? []) {
			const svc = g.Keys?.[0] ?? "";
			const amt = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
			const low = svc.toLowerCase();
			if (low.includes("quicksight")) continue; // explicitly skipped
			let label = "Others";
			for (const [lab, kws] of Object.entries(TARGET_KEYWORDS)) {
				if (kws.some((k) => low.includes(k))) {
					label = lab;
					break;
				}
			}
			out[label] = round2((out[label] ?? 0) + amt);
		}
	}

	return {
		cost: out,
		note: `Live Cost Explorer ${isoDate(start)} to ${isoDate(end)} (QuickSight excluded).`,
	};
}
