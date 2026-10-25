/**
 * DOCX report builder — properly structured Word report.
 *
 * Structure:
 *   1. Executive summary (KPI table, estimates clearly labeled)
 *   2. Savings by Service (service-wise savings table)
 *   3. Findings — one sub-table per AWS service
 *   4. Items for review (no measured saving)
 *   5. Prioritized savings plan
 *
 * Data rules (unchanged from the dashboard):
 *   - Only genuine savings (est. > $0/mo) appear in savings tables.
 *   - Current cost comes only from backend-computed meta; "—" when unknown.
 *   - Effort hours are planning estimates via the same keyword heuristic
 *     as the UI (`DEFAULT eff. 1h`), labeled as estimates in footnotes.
 *
 * Returns an ArrayBuffer so it works in both Node (tests) and Bun.
 */
import {
	Document,
	HeadingLevel,
	Packer,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun,
} from "docx";
import type { Finding, Payload } from "../types";
import { money, pyNum } from "./format";
import { PRIORITIZED_PLAN, REPORT_TITLE, DETAIL_REC_SEPARATOR } from "../rules/templates";

/** 10pt expressed in half-points, as required by the docx API. */
const TEN_PT = 20;

interface Effort {
	hours: number;
	assumed: boolean;
}

const EFFORT_RULES: Array<[RegExp, number]> = [
	[/Terminate if unneeded|Delete (idle|unused)|snapshot then delete|Delete after verifying|Delete if unneeded/i, 0.5],
	[/gp2|gp3/i, 0.5],
	[/retention|lifecycle|expiry|noncurrent/i, 1],
	[/schedule stop|nights\/weekends/i, 1],
	[/Downsize|rightsize|oversiz|consolidat/i, 2],
	[/NAT|VPC endpoints?/i, 1.5],
	[/Migrate|maintenance window|family down/i, 3],
	[/Serverless v2/i, 4],
	[/Karpenter|Spot|Graviton|Fargate/i, 8],
];

const DEFAULT_RATE = 75; // $/h planning assumption, stated in the doc footnote

export function effortHours(f: Finding): Effort {
	for (const [re, h] of EFFORT_RULES) {
		if (re.test(f.category) || re.test(f.recommendation)) return { hours: h, assumed: false };
	}
	return { hours: 1, assumed: true };
}

/** Backend-computed current monthly cost, or null when unknown. */
function currentCostMo(f: Finding): number | null {
	for (const v of [f.meta?.base_cost_mo, f.meta?.est_cost_mo]) {
		const n = Number((v as number | undefined) ?? NaN);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return null;
}

function run(value: string, bold = false): TextRun {
	return new TextRun({ text: value, size: TEN_PT, bold });
}

function para(value: string, bold = false): Paragraph {
	return new Paragraph({ children: [run(value, bold)] });
}

function heading(value: string, level: HeadingLevel = HeadingLevel.HEADING_2): Paragraph {
	return new Paragraph({ heading: level, children: [run(value)] });
}

function cell(value: string, bold = false): TableCell {
	return new TableCell({ children: [new Paragraph({ children: [run(value, bold)] })] });
}

function row(values: string[], bold = false): TableRow {
	return new TableRow({ children: values.map((v) => cell(v, bold)) });
}

export async function buildDocx(payload: Payload): Promise<ArrayBuffer> {
	const actionable = payload.findings.filter((f) => Number(f.est_monthly_saving_usd) > 0);
	const review = payload.findings.filter((f) => Number(f.est_monthly_saving_usd) <= 0);

	const totalMonthly = actionable.reduce((s, f) => s + Number(f.est_monthly_saving_usd || 0), 0);
	const totalAnnual = Math.round(totalMonthly * 12 * 100) / 100;
	let implHours = 0;
	for (const f of actionable) implHours += effortHours(f).hours;
	implHours = Math.round(implHours * 10) / 10;

	const services = [...new Set(actionable.map((f) => f.service))].sort(
		(a, b) =>
			actionable.filter((f) => f.service === b).reduce((s, f) => s + Number(f.est_monthly_saving_usd || 0), 0) -
			actionable.filter((f) => f.service === a).reduce((s, f) => s + Number(f.est_monthly_saving_usd || 0), 0),
	);

	const children: (Paragraph | Table)[] = [];

	// Title + meta
	children.push(heading(REPORT_TITLE, HeadingLevel.HEADING_1));
	children.push(
		para(
			`Region: ${payload.region}  |  Date: ${payload.date}  |  Lookback: ${payload.lookback_days} days`,
		),
	);
	children.push(para(payload.cost_note));
	children.push(para("All savings figures are ESTIMATES produced by this audit. Actual savings become measurable only after actions are applied and the next audit is run.", true));

	// 1. Executive summary
	children.push(heading("1. Executive Summary"));
	children.push(
		new Table({
			style: "TableGrid",
			rows: [
				row(["Metric", "Value"], true),
				row(["Findings", `${payload.findings.length} total (${actionable.length} actionable, ${review.length} for review)`]),
				row(["Est. monthly savings", `$${money(totalMonthly)}`]),
				row(["Est. annual savings", `$${money(totalAnnual)}`]),
				row(["Est. implementation effort", `${implHours}h labour-only, planning estimate (≤ $${Math.round(implHours * DEFAULT_RATE)} at ${DEFAULT_RATE}/h)`]),
			],
		}),
	);

	// 2. Savings by service
	children.push(heading("2. Savings by Service"));
	const svcRows: TableRow[] = [row(["AWS Service", "Findings", "Est. Monthly Savings (USD)"], true)];
	for (const svc of services) {
		const items = actionable.filter((f) => f.service === svc);
		const sum = items.reduce((s, f) => s + Number(f.est_monthly_saving_usd || 0), 0);
		svcRows.push(row([svc, String(items.length), `$${money(sum)}`]));
	}
	if (services.length > 0) svcRows.push(row(["TOTAL", String(actionable.length), `$${money(totalMonthly)}`], true));
	else svcRows.push(row(["(no measurable savings)", "—", "—"]));
	children.push(new Table({ style: "TableGrid", rows: svcRows }));

	// 3. Findings — one table per service
	children.push(heading("3. Detailed Findings by Service"));
	let seq = 1;
	if (services.length === 0) {
		children.push(para("No findings with measurable savings — well optimized."));
	}
	for (const svc of services) {
		const items = actionable.filter((f) => f.service === svc);
		const sum = items.reduce((s, f) => s + Number(f.est_monthly_saving_usd || 0), 0);
		children.push(
			heading(`3.${services.indexOf(svc) + 1} ${svc} — $${money(sum)}/mo est. savings (${items.length} findings)`, HeadingLevel.HEADING_3),
		);
		const rows: TableRow[] = [
			row(["#", "Resource", "Category", "Current /mo", "Est. saving /mo", "Detail → Recommendation", "Est. effort"], true),
		];
		for (const f of items) {
			rows.push(
				row([
					String(seq++),
					f.resource,
					f.category,
					currentCostMo(f) !== null ? `$${money(currentCostMo(f) as number)}` : "—",
					`$${pyNum(f.est_monthly_saving_usd)}`,
					f.detail + DETAIL_REC_SEPARATOR + f.recommendation,
					`${effortHours(f).hours}h`,
				]),
			);
		}
		children.push(new Table({ style: "TableGrid", rows }));
	}

	// 4. Review-only items
	if (review.length > 0) {
		children.push(heading("4. Items for Review (no measured saving)"));
		for (const f of review) {
			children.push(para(`• ${f.resource} (${f.service} · ${f.category}): ${f.recommendation}`));
		}
	}

	// 5. Prioritized plan
	children.push(heading(`${review.length > 0 ? 5 : 4}. Prioritized Savings Plan`));
	for (const line of PRIORITIZED_PLAN) children.push(para(line));
	children.push(
		para(
			"No additional licensing or third-party spend is required for the recommended actions (config / rightsize / delete tasks only).",
		),
	);

	const doc = new Document({ sections: [{ properties: {}, children }] });
	return Packer.toArrayBuffer(doc);
}
