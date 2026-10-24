/**
 * DOCX report writer — port of cost-optimization.py `write_docx`.
 *
 * Uses the pure-JS `docx` package (installed via npm) instead of python-docx.
 * Structure and copy mirror the Python writer:
 *   1. Live Cost by Service table
 *   2. Idle / Waste Findings table
 *   3. Prioritized Savings Plan
 * Body runs are set to 10pt, matching `r.font.size = Pt(10)`.
 *
 * Returns an ArrayBuffer so it works both in Node (tests) and the Workers
 * runtime without depending on Node's Buffer.
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
import type { Payload } from "../types";
import { money, pyNum } from "./format";
import {
	DETAIL_REC_SEPARATOR,
	DOC_HEADING_FINDINGS,
	DOC_HEADING_LIVE_COST,
	DOC_HEADING_PLAN,
	PRIORITIZED_PLAN,
	REPORT_TITLE,
} from "../rules/templates";

/** 10pt expressed in half-points, as required by the docx API. */
const TEN_PT = 20;

function run(value: string, bold = false): TextRun {
	return new TextRun({ text: value, size: TEN_PT, bold });
}

function para(value: string): Paragraph {
	return new Paragraph({ children: [run(value)] });
}

function heading(value: string): Paragraph {
	return new Paragraph({
		heading: HeadingLevel.HEADING_2,
		children: [run(value)],
	});
}

function cell(value: string, bold = false): TableCell {
	return new TableCell({
		children: [new Paragraph({ children: [run(value, bold)] })],
	});
}

function row(values: string[], bold = false): TableRow {
	return new TableRow({ children: values.map((v) => cell(v, bold)) });
}

export async function buildDocx(payload: Payload): Promise<ArrayBuffer> {
	const children: (Paragraph | Table)[] = [];

	children.push(
		new Paragraph({
			heading: HeadingLevel.HEADING_1,
			children: [run(REPORT_TITLE)],
		}),
	);
	children.push(
		para(
			`Region: ${payload.region} | Date: ${payload.date} | Lookback: ${payload.lookback_days} days`,
		),
	);
	children.push(para(payload.cost_note));

	// 1. Live Cost by Service
	children.push(heading(DOC_HEADING_LIVE_COST));
	const costEntries = Object.entries(payload.live_cost_by_service);
	const costRows: TableRow[] = [row(["Service", "Unblended Cost (USD)"], true)];
	if (costEntries.length === 0) {
		costRows.push(row(["(unavailable)", "$0.00"]));
	} else {
		for (const [k, v] of costEntries) costRows.push(row([k, `$${money(v)}`]));
	}
	children.push(new Table({ style: "TableGrid", rows: costRows }));

	// 2. Idle / Waste Findings
	children.push(heading(DOC_HEADING_FINDINGS));
	const findingRows: TableRow[] = [
		row(["Service", "Resource", "Category", "Detail + Recommendation", "Est. $/mo"], true),
	];
	for (const f of payload.findings) {
		findingRows.push(
			row([
				f.service,
				f.resource,
				f.category,
				f.detail + DETAIL_REC_SEPARATOR + f.recommendation,
				`$${pyNum(f.est_monthly_saving_usd)}`,
			]),
		);
	}
	children.push(new Table({ style: "TableGrid", rows: findingRows }));

	// 3. Prioritized Savings Plan
	children.push(heading(DOC_HEADING_PLAN));
	for (const line of PRIORITIZED_PLAN) children.push(para(line));

	const doc = new Document({ sections: [{ properties: {}, children }] });
	return Packer.toArrayBuffer(doc);
}
