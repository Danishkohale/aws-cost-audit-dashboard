/** S3 buckets — port of `cost-optimization.py:401-438` `audit_s3()` (base scan). */
import {
	GetBucketLifecycleConfigurationCommand,
	GetBucketVersioningCommand,
	ListBucketsCommand,
} from "@aws-sdk/client-s3";
import type { Finding } from "../../types";
import type { Aws } from "../clients";
import { addFinding } from "../findings";
import { type ScanRange, type ScanResult, sliceList } from "../range";
import { errMsg, round2 } from "../util";
import { CATEGORY } from "../../rules/templates";

/** Per-bucket counters that must survive between chunks. */
interface FootprintState {
	noLife: number;
	versioned: number;
	examples: string[];
}

export async function auditS3(
	aws: Aws,
	findings: Finding[],
	_days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let buckets: { Name?: string }[];
	try {
		buckets = (await aws.s3.send(new ListBucketsCommand({}))).Buckets ?? [];
	} catch (e) {
		addFinding(
			findings,
			"S3",
			"-",
			CATEGORY.accessIssue,
			`list_buckets failed: ${errMsg(e)}`,
			0,
			"Grant s3:List*.",
		);
		return { next: null };
	}

	const { items, next } = sliceList(buckets, range);
	const st: FootprintState = (range?.state as FootprintState) ?? {
		noLife: 0,
		versioned: 0,
		examples: [],
	};

	// 200+ buckets is common: aggregate instead of per-bucket findings so the
	// report stays readable. The aggregate row is only emitted on the last chunk,
	// which keeps its position (and text) identical to the single-pass Python run.
	for (const b of items) {
		const name = b.Name ?? "?";
		let hasLife = false;
		try {
			const life = await aws.s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: name }));
			hasLife = Boolean(life.Rules && life.Rules.length > 0);
		} catch {
			hasLife = false;
		}
		let ver = "Suspended";
		try {
			ver =
				(await aws.s3.send(new GetBucketVersioningCommand({ Bucket: name }))).Status ?? "Suspended";
		} catch {
			ver = "Unknown";
		}
		if (ver === "Enabled") st.versioned += 1;
		if (!hasLife) {
			st.noLife += 1;
			if (st.examples.length < 25) st.examples.push(`${name} (Versioning=${ver})`);
		}
	}

	if (next === null) {
		if (buckets.length > 0) {
			addFinding(
				findings,
				"S3",
				`${buckets.length} buckets scanned`,
				CATEGORY.s3Footprint,
				`${st.noLife}/${buckets.length} without lifecycle; ${st.versioned} versioned. ` +
					(st.examples.length > 0
						? `e.g. ${st.examples.slice(0, 5).join(", ")}`
						: "All have lifecycle."),
				round2(Math.min(st.noLife * 2, 300)),
				"Add lifecycle: expire noncurrent versions 30-90d, transition >30d Standard-IA, >90d Glacier, abort incomplete multipart after 7d; enable Intelligent-Tiering for unpredictable access.",
			);

			for (const n of st.examples) {
				addFinding(
					findings,
					"S3",
					n,
					CATEGORY.s3NoLifecycle,
					"No lifecycle rule. Old versions + IA transition missed.",
					2,
					"Add lifecycle rule as above.",
				);
			}
		}
		return { next: null };
	}

	return { next, state: st };
}
