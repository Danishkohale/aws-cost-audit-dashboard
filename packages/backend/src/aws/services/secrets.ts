/** Secrets Manager — port of `cost-optimization.py:361-379` `audit_secrets()`. */
import { DescribeSecretCommand, paginateListSecrets } from "@aws-sdk/client-secrets-manager";
import type { Finding } from "../../types";
import type { Aws } from "../clients";
import { addFinding } from "../findings";
import { type ScanRange, type ScanResult, fetchList, sliceList } from "../range";
import { ageDays, errMsg } from "../util";
import { pyDate } from "../../report/format";
import { CATEGORY } from "../../rules/templates";

interface Secret {
	Name?: string;
	LastAccessedDate?: Date | string | null;
}

export async function auditSecrets(
	aws: Aws,
	findings: Finding[],
	_days: number,
	range?: ScanRange,
): Promise<ScanResult> {
	let secrets: Secret[];
	try {
		secrets = await fetchList<Secret>(
			paginateListSecrets({ client: aws.secrets }, {}) as AsyncIterable<unknown>,
			"SecretList",
			range,
		);
	} catch (e) {
		addFinding(
			findings,
			"Secrets Manager",
			"-",
			CATEGORY.accessIssue,
			`list_secrets failed: ${errMsg(e)}`,
			0,
			"Grant secretsmanager:List*.",
		);
		return { next: null };
	}

	const { items, next } = sliceList(secrets, range);

	for (const s of items) {
		const name = s.Name ?? "?";
		let d: Secret;
		try {
			d = (await aws.secrets.send(new DescribeSecretCommand({ SecretId: name }))) as Secret;
		} catch {
			d = s;
		}
		const last = d.LastAccessedDate;
		const age = ageDays(last);
		const stale = last === null || last === undefined || (age !== null && age > 90);
		if (stale) {
			addFinding(
				findings,
				"Secrets Manager",
				name,
				CATEGORY.secretUnused,
				`Not accessed in 90d+ (last=${pyDate(last)}). $0.40/secret/mo + API.`,
				0.4,
				"Delete unused secret (recoverable 7-30d) or consolidate JSON into one secret.",
			);
		}
	}

	return { next };
}
