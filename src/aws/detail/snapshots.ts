/** Deep snapshot rows — port of `detailed_audit.py:179-228` `detail_snapshots()`. */
import { paginateDescribeImages, paginateDescribeSnapshots } from "@aws-sdk/client-ec2";
import type { Finding } from "../../types";
import type { Aws } from "../clients";
import { addDetail } from "../findings";
import { fetchAllBounded, type ScanRange, type ScanResult } from "../range";
import { ageDays, errMsg, round2 } from "../util";
import { pyNum } from "../../report/format";
import { CATEGORY } from "../../rules/templates";
import { SNAP_GB_MO } from "../../rules/pricing";

interface Snap {
	SnapshotId?: string;
	VolumeSize?: number;
	StartTime?: Date | string;
	Description?: string;
}

interface Image {
	BlockDeviceMappings?: { Ebs?: { SnapshotId?: string } }[];
}

/** Python default for `detail_snapshots(cap=60)`. */
const CAP = 60;

/** Python tuple-comparison semantics for the mixed-type sort keys. */
function cmpScalar(x: number | string, y: number | string): number {
	if (typeof x === "number" && typeof y === "number") return x - y;
	return String(x) < String(y) ? -1 : 1;
}

function compareTuple(a: (number | string)[], b: (number | string)[]): number {
	for (let i = 0; i < a.length; i++) {
		if (a[i] === b[i]) continue;
		return cmpScalar(a[i], b[i]);
	}
	return 0;
}

/**
 * Not chunked: the "60 oldest" selection needs the whole snapshot list, so this
 * runs in one call. Both listings are bounded so the step still fits the
 * 50-subrequest budget on very large accounts.
 */
export async function detailSnapshots(
	aws: Aws,
	findings: Finding[],
	_days: number,
	_range?: ScanRange,
): Promise<ScanResult> {
	let snaps: Snap[];
	try {
		snaps = await fetchAllBounded<Snap>(
			paginateDescribeSnapshots(
				{ client: aws.ec2 },
				{ OwnerIds: ["self"] },
			) as AsyncIterable<unknown>,
			"Snapshots",
		);
	} catch (e) {
		addDetail(
			findings,
			"Snapshot",
			"-",
			CATEGORY.accessIssue,
			`describe_snapshots failed: ${errMsg(e)}`,
			0,
			"Grant ec2:Describe*.",
		);
		return { next: null };
	}

	const linked = new Set<string>();
	try {
		const imgs = await fetchAllBounded<Image>(
			paginateDescribeImages({ client: aws.ec2 }, { Owners: ["self"] }) as AsyncIterable<unknown>,
			"Images",
		);
		for (const im of imgs) {
			for (const b of im.BlockDeviceMappings ?? []) {
				const s = b.Ebs?.SnapshotId;
				if (s) linked.add(s);
			}
		}
	} catch {
		/* AMI linkage is best-effort */
	}

	interface Row {
		age: number;
		sid: string;
		size: number;
		cost: number;
		isLinked: boolean;
		desc: string;
		key: (number | string)[];
	}

	const rows: Row[] = [];
	for (const s of snaps) {
		try {
			const sid = s.SnapshotId ?? "?";
			const size = s.VolumeSize ?? 0;
			const age = ageDays(s.StartTime) ?? 0;
			const cost = round2(size * SNAP_GB_MO);
			const isLinked = linked.has(sid);
			const desc = (s.Description ?? "").slice(0, 80);
			rows.push({
				age,
				sid,
				size,
				cost,
				isLinked,
				desc,
				key: [age, sid, size, cost, isLinked ? 1 : 0, desc],
			});
		} catch {
			continue;
		}
	}

	rows.sort((a, b) => -compareTuple(a.key, b.key));

	if (rows.length > CAP) {
		const tot = round2(rows.reduce((sum, r) => sum + r.cost, 0));
		addDetail(
			findings,
			"Snapshot",
			`${rows.length} snapshots`,
			CATEGORY.snapSummary,
			`${rows.length} self-owned snapshots ≈ $${pyNum(tot)}/mo at $0.05/GB-mo. Showing ${CAP} oldest.`,
			round2(Math.min(tot * 0.4, 300)),
			"Delete >90d unlinked snapshots; use DLM retention; keep AMI-linked only.",
		);
	}

	for (const r of rows.slice(0, CAP)) {
		if (r.isLinked) continue;
		if (r.age >= 90) {
			addDetail(
				findings,
				"Snapshot",
				r.sid,
				CATEGORY.snapOldUnlinked,
				`${r.size}GB, age ${r.age}d, ~$${pyNum(r.cost)}/mo. Not linked to any AMI. Desc: ${r.desc || "—"}.`,
				r.cost,
				"Delete after verifying no restore need; enforce DLM 30-90d retention.",
				{ size_gb: r.size, age_days: r.age, ami_linked: false },
			);
		} else if (r.age >= 30 && r.size >= 50) {
			addDetail(
				findings,
				"Snapshot",
				r.sid,
				CATEGORY.snapLargeUnlinked,
				`${r.size}GB, age ${r.age}d, ~$${pyNum(r.cost)}/mo, unlinked.`,
				round2(r.cost * 0.5),
				"Confirm restore need; else delete.",
				{ size_gb: r.size, age_days: r.age, ami_linked: false },
			);
		}
	}

	return { next: null };
}
