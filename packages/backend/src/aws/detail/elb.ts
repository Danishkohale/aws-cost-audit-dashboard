/** Deep ELB rows — port of `detailed_audit.py:444-501` `detail_elb()`. */
import {
	DescribeTargetHealthCommand,
	paginateDescribeLoadBalancers as paginateElbv2LoadBalancers,
	paginateDescribeTargetGroups,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { paginateDescribeLoadBalancers as paginateClassicLoadBalancers } from "@aws-sdk/client-elastic-load-balancing";
import type { Finding, FindingMeta } from "../../types";
import type { Aws } from "../clients";
import { addDetail } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, fetchList, isFirst, sliceList } from "../range";
import { ageDays, errMsg, round2 } from "../util";
import { f0, f1 } from "../../report/format";
import { CATEGORY } from "../../rules/templates";

interface Lb {
	LoadBalancerArn?: string;
	LoadBalancerName?: string;
	Type?: string;
	Scheme?: string;
	CreatedTime?: Date | string;
}

function lbDimValue(arn: string): string {
	const idx = arn.indexOf("/");
	return idx === -1 ? "" : arn.slice(idx + 1);
}

export async function detailElb(
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
		addDetail(
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
		const typ = lb.Type;
		try {
			const scheme = lb.Scheme ?? "?";
			const age = ageDays(lb.CreatedTime);
			const tgs = await fetchList<{ TargetGroupArn?: string }>(
				paginateDescribeTargetGroups(
					{ client: aws.elbv2 },
					{ LoadBalancerArn: arn },
				) as AsyncIterable<unknown>,
				"TargetGroups",
			);

			let healthy = 0;
			let unhealthy = 0;
			for (const tg of tgs) {
				try {
					const h = await aws.elbv2.send(
						new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }),
					);
					for (const t of h.TargetHealthDescriptions ?? []) {
						if (t.TargetHealth?.State === "healthy") healthy += 1;
						else unhealthy += 1;
					}
				} catch {
					/* skip target group */
				}
			}

			const short = arn.includes("/") ? lbDimValue(arn) : "";
			const dim = short ? [{ Name: "LoadBalancer", Value: short }] : [];
			const req =
				typ === "application"
					? await cwAvg(aws.cw, "AWS/ApplicationELB", "RequestCount", dim, days, "Sum")
					: null;
			const proc = await cwAvg(
				aws.cw,
				typ === "application" ? "AWS/ApplicationELB" : "AWS/NetworkELB",
				"ProcessedBytes",
				dim,
				days,
				"Sum",
			);

			const io =
				(req !== null ? `${f0(req)} req/${days}d` : "req metrics n/a") +
				(proc !== null ? `, ${f1(proc / 1e9)}GB processed` : "") +
				`, targets ${healthy} healthy/${unhealthy} unhealthy, ${scheme}, age ${age}d`;

			const meta: FindingMeta = {
				type: typ ?? null,
				scheme,
				age_days: age,
				healthy,
				unhealthy,
				requests: req,
				processed_gb: proc ? round2(proc / 1e9) : null,
			};

			if (healthy === 0) {
				addDetail(
					findings,
					"ELB",
					name,
					CATEGORY.elbNoTargets,
					`${typ} ${scheme}. I/O: ${io}. Base ~$16-25/mo + LCU.`,
					20,
					"Delete idle LB or fix target health.",
					meta,
				);
			} else if (req !== null && req < 1000) {
				addDetail(
					findings,
					"ELB",
					name,
					CATEGORY.elbNearZero,
					`${typ}. I/O: ${io}.`,
					18,
					"Consolidate listeners onto one ALB; delete unused.",
					meta,
				);
			} else {
				addDetail(
					findings,
					"ELB",
					name,
					CATEGORY.elbInUse,
					`${typ} ${scheme}. I/O: ${io}.`,
					0,
					"No action.",
					meta,
				);
			}
		} catch {
			continue;
		}
	}

	if (isFirst(range)) {
		try {
			const old = await fetchList<{
				LoadBalancerName?: string;
				Instances?: unknown[];
				CreatedTime?: Date | string;
			}>(
				paginateClassicLoadBalancers({ client: aws.elb }, {}) as AsyncIterable<unknown>,
				"LoadBalancerDescriptions",
			);
			for (const lb of old) {
				const nm = lb.LoadBalancerName ?? "?";
				const insts = lb.Instances ?? [];
				const age = ageDays(lb.CreatedTime);
				if (insts.length === 0) {
					addDetail(
						findings,
						"ELB",
						nm,
						CATEGORY.elbClassicEmpty,
						`CLB with 0 instances, age ${age}d. ~$18/mo.`,
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
