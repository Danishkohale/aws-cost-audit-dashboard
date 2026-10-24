/**
 * Credential vault — in-memory with TTL for Bun/Node deployment.
 * Replaces Durable Object with a simple Map + setTimeout cleanup.
 */
import type { AwsCreds } from "../types";

const TTL_MS = 30 * 60 * 1000;
const store = new Map<string, { creds: AwsCreds; timeout: NodeJS.Timeout }>();

export async function putCreds(jobId: string, creds: AwsCreds): Promise<void> {
	// Clear existing if any
	const existing = store.get(jobId);
	if (existing) clearTimeout(existing.timeout);

	const timeout = setTimeout(() => {
		store.delete(jobId);
	}, TTL_MS);

	store.set(jobId, { creds, timeout });
}

export async function getCreds(jobId: string): Promise<AwsCreds | null> {
	const entry = store.get(jobId);
	return entry?.creds ?? null;
}

export async function clearCreds(jobId: string): Promise<void> {
	const entry = store.get(jobId);
	if (entry) {
		clearTimeout(entry.timeout);
		store.delete(jobId);
	}
}