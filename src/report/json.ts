/**
 * JSON report writer — port of cost-optimization.py `write_json`.
 *
 * Python: `json.dump(payload, f, indent=2, default=str)`.
 * Output is 2-space indented and stable for a given payload.
 *
 * Note: Python escapes non-ASCII by default (`ensure_ascii=True`), so an em
 * dash renders as `\u2014`. We emit literal UTF-8 instead — the frontend and
 * DOCX render identically; only the byte encoding differs.
 */
import type { Payload } from "../types";

export function buildJson(payload: Payload): string {
	return JSON.stringify(payload, null, 2);
}
