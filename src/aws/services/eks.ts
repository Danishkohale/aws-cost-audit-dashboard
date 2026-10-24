/** EKS clusters — port of `cost-optimization.py:326-359` `audit_eks()` (base scan). */
import {
	DescribeClusterCommand,
	DescribeNodegroupCommand,
	paginateListClusters,
	paginateListNodegroups,
} from "@aws-sdk/client-eks";
import type { Finding } from "../../types";
import type { Aws } from "../clients";
import { addFinding } from "../findings";
import { type ScanRange, type ScanResult, fetchList, sliceList } from "../range";
import { errMsg } from "../util";
import { pyList } from "../../report/format";
import { CATEGORY } from "../../rules/templates";

interface Nodegroup {
	scalingConfig?: { desiredSize?: number };
	instanceTypes?: string[];
}

export async function auditEks(
	aws: Aws,
	findings: Finding[],
	_days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let clusters: string[];
	try {
		clusters = await fetchList<string>(
			paginateListClusters({ client: aws.eks }, {}) as AsyncIterable<unknown>,
			"clusters",
			range,
		);
	} catch (e) {
		addFinding(
			findings,
			"EKS",
			"-",
			CATEGORY.accessIssue,
			`list_clusters failed: ${errMsg(e)}`,
			0,
			"Grant eks:List*+Describe*.",
		);
		return { next: null };
	}

	const { items, next } = sliceList(clusters, range);

	for (const cname of items) {
		let c: { version?: string };
		try {
			const out = await aws.eks.send(new DescribeClusterCommand({ name: cname }));
			c = out.cluster ?? {};
		} catch (e) {
			addFinding(findings, "EKS", cname, CATEGORY.accessIssue, errMsg(e), 0, "");
			continue;
		}

		const ver = c.version ?? "?";
		if (ver < "1.28") {
			addFinding(
				findings,
				"EKS",
				cname,
				CATEGORY.eksOldVersion,
				`v${ver}. Extended support fees apply after EOL (~$0.60/cluster-hr extra).`,
				25,
				"Upgrade to supported version (1.28+).",
			);
		}

		try {
			const ngs = await fetchList<string>(
				paginateListNodegroups(
					{ client: aws.eks },
					{ clusterName: cname },
				) as AsyncIterable<unknown>,
				"nodegroups",
			);
			if (ngs.length === 0) {
				addFinding(
					findings,
					"EKS",
					cname,
					CATEGORY.eksNoNodegroups,
					"Cluster with no nodegroups still pays $73/mo control plane.",
					73,
					"Delete idle cluster or run workloads on Fargate Spot.",
				);
			}
			for (const ng of ngs) {
				const out = await aws.eks.send(
					new DescribeNodegroupCommand({ clusterName: cname, nodegroupName: ng }),
				);
				const d: Nodegroup = out.nodegroup ?? {};
				const sc = d.scalingConfig ?? {};
				const first = (d.instanceTypes ?? [""])[0] ?? "";
				if ((sc.desiredSize ?? 0) >= 3 && first.startsWith("m5.")) {
					addFinding(
						findings,
						"EKS",
						`${cname}/${ng}`,
						CATEGORY.eksNodegroupSizing,
						`desired=${sc.desiredSize ?? "None"}, ${pyList(d.instanceTypes)}.`,
						40,
						"Use Karpenter/CA + Spot, Graviton (m7g), right-size via Container Insights.",
					);
				}
			}
		} catch {
			/* nodegroup detail optional */
		}
	}

	return { next };
}
