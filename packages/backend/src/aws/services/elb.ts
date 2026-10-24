/** ELB (ALB/NLB + classic) — port of `cost-optimization.py:263-302` `audit_elb()` (base scan). */
import {
	DescribeTargetHealthCommand,
	paginateDescribeLoadBalancers as paginateElbv2LoadBalancers,
	paginateDescribeTargetGroups,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { paginateDescribeLoadBalancers as paginateClassicLoadBalancers } from "@aws-sdk/client-elastic-load-balancing";
import type { Finding } from "../../types";
import type { Aws } from "../clients";
import { addFinding } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, fetchList, isFirst, sliceList } from "../range";
import { errMsg } from "../util";
import { f0 } from "../../report/format";
import { CATEGORY } from "../../rules/templates";

interface Lb {
	LoadBalancerArn?: string;
	LoadBalancerName?: string;
	Type?: string;
}

/** boto3 `arn.split("/", 1)[1]` → everything after the first "/". */
function lbDimValue(arn: string): string {
	const idx = arn.indexOf("/");
	return idx === -1 ? "" : arn.slice(idx + 1);
}

export async function auditElb(
	aws: Aws,
	findings: Finding[],
	days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let lbs: Lb[];
	try {
		lbs = await fetchList<Lb>(
			paginateElbv2LoadBalancers({ client: aws.elbv2 }, {}) as AsyncIterable<unknown>,
			"LoadBalancers",
			range,
		);
	} catch (e) {
		addFinding(
			findings,
			"ELB",
			"-",
			CATEGORY.accessIssue,
			`describe_load_balancers failed: ${errMsg(e)}`,
			0,
			"Grant elasticloadbalancing:Describe*.",
		);
		return { next: null };
	}

	const { items, next } = sliceList(lbs, range);

	for (const lb of items) {
		const arn = lb.LoadBalancerArn ?? "";
		const name = lb.LoadBalancerName ?? "?";
		const typ = lb.Type ?? "?";
		let tgs: { TargetGroupArn?: string }[] = [];
		try {
			tgs = await fetchList<{ TargetGroupArn?: string }>(
				paginateDescribeTargetGroups(
					{ client: aws.elbv2 },
					{ LoadBalancerArn: arn },
				) as AsyncIterable<unknown>,
				"TargetGroups",
			);
		} catch {
			tgs = [];
		}

		let healthy = 0;
		for (const tg of tgs) {
			try {
				const h = await aws.elbv2.send(
					new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }),
				);
				healthy += (h.TargetHealthDescriptions ?? []).filter(
					(t) => t.TargetHealth?.State === "healthy",
				).length;
			} catch {
				/* skip target group */
			}
		}

		const req = await cwAvg(
			aws.cw,
			"AWS/ApplicationELB",
			"RequestCount",
			arn.includes("/") ? [{ Name: "LoadBalancer", Value: lbDimValue(arn) }] : [],
			days,
			"Sum",
		);

		if (healthy === 0) {
			addFinding(
				findings,
				"ELB",
				name,
				CATEGORY.elbNoTargets,
				`${typ} with 0 healthy targets. ~$16-25/mo base + LCU.`,
				20,
				"Delete idle LB or fix target health; replace CLB with ALB.",
			);
		} else if (req !== null && req < 1000) {
			addFinding(
				findings,
				"ELB",
				name,
				CATEGORY.elbNearZero,
				`${typ}, ~${f0(req)} req/${days}d with ${healthy} targets.`,
				18,
				"Consolidate listeners/rules onto one ALB; delete unused LBs.",
			);
		}
	}

	// Classic ELBs are a whole-account list, so only the first chunk covers them.
	if (isFirst(range)) {
		try {
			const old = await fetchList<{ LoadBalancerName?: string; Instances?: unknown[] }>(
				paginateClassicLoadBalancers({ client: aws.elb }, {}) as AsyncIterable<unknown>,
				"LoadBalancerDescriptions",
			);
			for (const lb of old) {
				if (!lb.Instances || lb.Instances.length === 0) {
					addFinding(
						findings,
						"ELB",
						lb.LoadBalancerName ?? "?",
						CATEGORY.elbClassicEmpty,
						"CLB with zero instances.",
						18,
						"Delete; migrate to ALB/NLB.",
					);
				}
			}
		} catch {
			/* classic ELB optional */
		}
	}

	return { next };
}
