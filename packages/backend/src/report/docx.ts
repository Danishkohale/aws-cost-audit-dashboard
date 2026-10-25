/**
 * DOCX report builder — properly structured, professionally styled Word report.
 *
 * Structure & language:
 *   Title page block  → title, subtitle, account/date context
 *   1. Executive Summary            (KPI table, estimates labeled)
 *   2. Potential Monthly Savings by Service (service-wise savings table)
 *   3. Findings & Recommended Actions by Service (one table per service)
 *   4. Additional Items Requiring Review (no measured saving)
 *   5. Recommended Action Plan
 *
 * Styling:
 *   - Dark slate table headers with white bold text
 *   - Alternating (zebra) row shading
 *   - Green (16A34A) for savings KPIs, totals and saving cells
 *   - Colored section headings
 *
 * Data rules (unchanged from the dashboard):
 *   - Only genuine savings (est. > $0/mo) appear in savings tables.
 *   - Current cost comes only from backend-computed meta; "—" when unknown.
 *   - Effort hours are planning estimates via a keyword heuristic, labeled.
 *
 * Returns an ArrayBuffer so it works in both Node (tests) and Bun.
 */
import {
	Document,
	HeadingLevel,
	Packer,
	Paragraph,
	ShadingType,
	Table,
	TableCell,
	TableRow,
	TextRun,
} from "docx";
import type { Finding, Payload } from "../types";
import { money, pyNum } from "./format";
import { PRIORITIZED_PLAN } from "../rules/templates";

/** 10pt expressed in half-points, as required by the docx API. */
const TEN_PT = 20;

// Palette (hex, no #)
const GREEN = "15803D"; // savings emphasis
const DARK = "1F2937"; // table header fill
const ZEBRA = "F3F4F6"; // alternating row fill
const WHITE = "FFFFFF";
const SLATE = "475569"; // muted copy

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

function run(value: string, bold = false, color?: string): TextRun {
	return new TextRun({ text: value, size: TEN_PT, bold, color });
}

interface CellOpts {
	bold?: boolean;
	color?: string;
	fill?: string;
}

function cell(value: string, opts: CellOpts = {}): TableCell {
	return new TableCell({
		shading: opts.fill ? { type: ShadingType.CLEAR, color: "auto", fill: opts.fill } : undefined,
		children: [new Paragraph({ children: [run(value, opts.bold ?? false, opts.color)] })],
	});
}

function headRow(labels: string[]): TableRow {
	return new TableRow({ children: labels.map((l) => cell(l, { bold: true, color: WHITE, fill: DARK })) });
}

function row(values: string[], opts: CellOpts = {}): TableRow {
	return new TableRow({ children: values.map((v) => cell(v, opts)) });
}

function heading(value: string, level: HeadingLevel = HeadingLevel.HEADING_2): Paragraph {
	return new Paragraph({ heading: level, children: [run(value, true, level === HeadingLevel.HEADING_3 ? GREEN : DARK)] });
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

	// ── Title block ────────────────────────────────────────────────────
	children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [run("AWS Cost Optimization Report", true, DARK)] }));
	children.push(new Paragraph({ children: [run("Idle, over-provisioned and obsolete resource findings", false, SLATE)] }));
	children.push(
		new Paragraph({
			children: [
				run(`Account region: ${payload.region}    Audit date: ${payload.date}    Cost-Explorer lookback: ${payload.lookback_days} days`, false, SLATE),
			],
		}),
	);
	if (payload.cost_note) children.push(new Paragraph({ children: [run(payload.cost_note, false, SLATE)] }));
	children.push(
		new Paragraph({
			spacing: { before: 120, after: 240 },
			children: [
				run("Every dollar figure in this report is an estimate produced by this audit. Actual savings become measurable only after the recommended actions are applied and the next audit is run.", true, SLATE),
			],
		}),
	);

	// ── 1. Executive summary ──────────────────────────────────────────
	children.push(heading("1. Executive Summary"));
	children.push(
		new Table({
			style: "TableGrid",
			rows: [
				headRow(["Metric", "Value"]),
				zebra([
					cell("Audited resources with findings", { fill: ZEBRA }),
					cell(`${payload.findings.length} total — ${actionable.length} actionable, ${review.length} for review`, { fill: ZEBRA }),
				]),
				row(["Estimated monthly savings", `$${money(totalMonthly)}`]),
				zebra([
					cell("Estimated annual savings (12 × monthly)", { fill: ZEBRA }),
					cell(`$${money(totalAnnual)}`, { bold: true, color: GREEN, fill: ZEBRA }),
				]),
				row(["Estimated implementation effort", `${implHours} h of work, planning estimate only (≈ $${Math.round(implHours * DEFAULT_RATE)} labour at ${DEFAULT_RATE}/h)`]),
			],
		}),
	);

	// ── 2. Savings by service ─────────────────────────────────────────
	children.push(heading("2. Potential Monthly Savings by Service"));
	const svcRows: TableRow[] = [headRow(["AWS Service", "Findings", "Est. Savings / Month (USD)"])];
	if (services.length === 0) svcRows.push(row(["No measurable savings identified", "—", "—"]));
	services.forEach((svc, idx) => {
		const items = actionable.filter((f) => f.service === svc);
		const sum = items.reduce((s, f) => s + Number(f.est_monthly_saving_usd || 0), 0);
		const opts: CellOpts = idx % 2 === 1 ? { fill: ZEBRA } : {};
		svcRows.push(
			new TableRow({
				children: [
					cell(svc, { ...opts, bold: true }),
					cell(String(items.length), { ...opts }),
					cell(`$${money(sum)}`, { ...opts, bold: true, color: GREEN }),
				],
			}),
		);
	});
	if (services.length > 0) {
		svcRows.push(
			new TableRow({
				children: [cell("TOTAL", { bold: true, color: WHITE, fill: DARK }), cell(String(actionable.length), { bold: true, color: WHITE, fill: DARK }), cell(`$${money(totalMonthly)}`, { bold: true, color: WHITE, fill: DARK })],
			}),
		);
	}
	children.push(new Table({ style: "TableGrid", rows: svcRows }));

	// ── 3. Findings per service ───────────────────────────────────────
	children.push(heading("3. Findings and Recommended Actions, by Service"));
	if (services.length > 0) {
		children.push(
			new Paragraph({
				spacing: { after: 120 },
				children: [run("Findings are ordered by monthly saving within each service. “—” means the current cost was not measurable in this cost window.", false, SLATE)],
			}),
		);
	}
	let seq = 1;
	services.forEach((svc, svcIdx) => {
		const items = actionable.filter((f) => f.service === svc);
		const sum = items.reduce((s, f) => s + Number(f.est_monthly_saving_usd || 0), 0);
		children.push(heading(`3.${svcIdx + 1}  ${svc} — $${money(sum)} per month across ${items.length} finding${items.length === 1 ? "" : "s"}`, HeadingLevel.HEADING_3));
		const rows: TableRow[] = [headRow(["#", "Resource", "Finding", "Current /mo", "Est. saving /mo", "Recommended action", "Effort"])];
		items.forEach((f, idx) => {
			const fill = idx % 2 === 1 ? ZEBRA : undefined;
			rows.push(
				new TableRow({
					children: [
						cell(String(seq++), { fill, color: SLATE }),
						cell(f.resource, { fill, bold: true }),
						cell(f.category, { fill }),
						cell(currentCostMo(f) !== null ? `$${money(currentCostMo(f) as number)}` : "—", { fill, color: SLATE }),
						cell(`$${pyNum(f.est_monthly_saving_usd)}`, { fill, bold: true, color: GREEN }),
						cell(f.recommendation, { fill }),
						cell(`${effortHours(f).hours} h`, { fill, color: SLATE }),
					],
				}),
			);
			rows.push(
				new TableRow({
					children: [
						cell("", { fill }),
						new TableCell({
							columnSpan: 6,
							shading: fill ? { type: ShadingType.CLEAR, color: "auto", fill } : undefined,
							children: [new Paragraph({ children: [run(`Detail: ${f.detail}`, false, SLATE)] })],
						}),
					],
				}),
			);
		});
		children.push(new Table({ style: "TableGrid", rows }));
		children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
	});

	// ── 4. Review-only items ──────────────────────────────────────────
	if (review.length > 0) {
		children.push(heading("4. Additional Items Requiring Review (No Measured Saving)"));
		children.push(
			new Paragraph({
				spacing: { after: 120 },
				children: [run("These resources show waste signals but no measurable dollar saving in this cost window — confirm with the owning team before acting.", false, SLATE)],
			}),
		);
		for (const f of review) {
			children.push(new Paragraph({ children: [run(`•  ${f.resource}`, true), run(`  (${f.service} · ${f.category}) — ${f.recommendation}`, false, SLATE)] }));
		}
	}

	// ── 5. Action plan ────────────────────────────────────────────────
	children.push(heading(`${review.length > 0 ? 5 : 4}. Recommended Action Plan`));
	children.push(
		new Paragraph({
			spacing: { after: 120 },
			children: [run("Work top-to-bottom: the highest monthly savings are listed first and typically require the least effort.", false, SLATE)],
		}),
	);
	for (const line of PRIORITIZED_PLAN) children.push(new Paragraph({ text: `•  ${line}` }));
	children.push(
		new Paragraph({
			spacing: { before: 120 },
			children: [run("None of the recommended actions require new licences or third-party spend — they are configuration, right-sizing and removal tasks performed inside your AWS account.", false, SLATE)],
		}),
	);

	children.push(
		new Paragraph({
			spacing: { before: 240 },
			children: [run(`Effort figures are rough planning estimates for a mid-level engineer at ${DEFAULT_RATE}/hour; they are not quotations. Savings figures derive from the measured usage signals shown; treat them as targets, not guarantees.`, false, SLATE)],
		}),
	);

	const doc = new Document({ sections: [{ properties: {}, children }] });
	return Packer.toArrayBuffer(doc);
}

/** Zebra row helper keeps types clean for two-cell tables. */
function zebra(cells: [TableCell, TableCell]): TableRow {
	return new TableRow({ children: cells });
}
