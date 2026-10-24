/** Deep S3 rows — port of `detailed_audit.py:292-351` `detail_s3()`. */
import {
	GetBucketLifecycleConfigurationCommand,
	GetBucketVersioningCommand,
	ListBucketsCommand,
} from "@aws-sdk/client-s3";
import type { Finding, FindingMeta } from "../../types";
import type { Aws } from "../clients";
import { addDetail } from "../findings";
import { cwAvg } from "../metrics";
import { type ScanRange, type ScanResult, sliceList } from "../range";
import { errMsg, round2 } from "../util";
import { comma, f0, f1, pyNum } from "../../report/format";
import { CATEGORY } from "../../rules/templates";
import { S3_STD_GB_MO } from "../../rules/pricing";

/** Python caps the deep layer at 100 buckets; beyond that it emits a truncation row. */
const CAP = 100;

interface DetailState {
	shown: number;
}

export async function detailS3(
	aws: Aws,
	findings: Finding[],
	days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let buckets: { Name?: string }[];
	try {
		buckets = (await aws.s3.send(new ListBucketsCommand({}))).Buckets ?? [];
	} catch (e) {
		addDetail(
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

	const capped = buckets.slice(0, CAP);
	const { items, next } = sliceList(capped, range);
	const st: DetailState = (range?.state as DetailState) ?? { shown: 0 };

	for (const b of items) {
		const name = b.Name ?? "?";
		try {
			let hasLife = false;
			try {
				const life = await aws.s3.send(
					new GetBucketLifecycleConfigurationCommand({ Bucket: name }),
				);
				hasLife = Boolean(life.Rules && life.Rules.length > 0);
			} catch {
				hasLife = false;
			}
			let ver = "Suspended";
			try {
				ver =
					(await aws.s3.send(new GetBucketVersioningCommand({ Bucket: name }))).Status ??
					"Suspended";
			} catch {
				ver = "Unknown";
			}

			const sizeB = await cwAvg(
				aws.cw,
				"AWS/S3",
				"BucketSizeBytes",
				[
					{ Name: "BucketName", Value: name },
					{ Name: "StorageType", Value: "StandardStorage" },
				],
				2,
			);
			const objs = await cwAvg(
				aws.cw,
				"AWS/S3",
				"NumberOfObjects",
				[
					{ Name: "BucketName", Value: name },
					{ Name: "StorageType", Value: "AllStorageTypes" },
				],
				2,
			);
			const gets = await cwAvg(
				aws.cw,
				"AWS/S3",
				"GetRequests",
				[{ Name: "BucketName", Value: name }],
				days,
				"Sum",
			);
			const puts = await cwAvg(
				aws.cw,
				"AWS/S3",
				"PutRequests",
				[{ Name: "BucketName", Value: name }],
				days,
				"Sum",
			);

			const sizeGb = (sizeB ?? 0) / 1e9;
			const io =
				(sizeB !== null
					? `size ${f1(sizeGb)}GB, ${comma(objs ?? 0)} objects`
					: "size metrics unavailable") +
				(gets !== null
					? `, GET ${f0(gets)} / PUT ${f0(puts)} per ${days}d`
					: ", request metrics off");
			const cost = round2(sizeGb * S3_STD_GB_MO);

			const meta: FindingMeta = {
				bucket: name,
				size_gb: round2(sizeGb),
				objects: objs !== null ? Math.trunc(objs) : null,
				gets,
				puts,
				lifecycle: hasLife,
				versioning: ver,
				est_cost_mo: cost,
			};

			if (sizeGb < 0.1 && (gets ?? 0) < 100) {
				addDetail(
					findings,
					"S3",
					name,
					CATEGORY.s3IdleBucket,
					`Versioning=${ver}, lifecycle=${hasLife ? "on" : "off"}. I/O: ${io}. Costs ~$${pyNum(cost)}/mo + request fees.`,
					cost,
					"Delete if unneeded (check app refs first) or add lifecycle abort-multipart-7d.",
					meta,
				);
			} else if (!hasLife && sizeGb >= 1) {
				addDetail(
					findings,
					"S3",
					name,
					CATEGORY.s3NoLifecycle,
					`Versioning=${ver}. I/O: ${io}. ~$${pyNum(cost)}/mo Standard; old versions accumulate. Est. save ~$${pyNum(round2(Math.min(sizeGb * 0.01, 200)))}/mo via IA/Glacier transitions.`,
					round2(Math.min(sizeGb * 0.01, 200)),
					"Add lifecycle: noncurrent expire 30-90d, >30d Standard-IA, >90d Glacier, abort multipart 7d; Intelligent-Tiering for unknown access.",
					meta,
				);
			} else if (ver === "Enabled" && !hasLife) {
				addDetail(
					findings,
					"S3",
					name,
					CATEGORY.s3Versioned,
					`I/O: ${io}. Noncurrent versions billed forever (~$${pyNum(cost)}/mo).`,
					round2(Math.min(cost * 0.4, 100)),
					"Add noncurrent-version expiry 30-90d.",
					meta,
				);
			}
			st.shown += 1;
		} catch {
			continue;
		}
	}

	if (next === null) {
		if (buckets.length > CAP) {
			addDetail(
				findings,
				"S3",
				`${buckets.length} buckets`,
				CATEGORY.s3Truncated,
				`Showing ${st.shown}/${buckets.length} buckets (cap ${CAP}).`,
				0,
				"Raise cap or split by prefix for full coverage.",
			);
		}
		return { next: null };
	}

	return { next, state: st };
}
