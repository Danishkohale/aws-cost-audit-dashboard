/**
 * Test database — uses the same SQLite module as production.
 */
import { createTestDb as createSqliteTestDb } from "./sqlite.helper";

export const createTestDb = createSqliteTestDb;

export function createTestCredsNamespace() {
	const store = new Map<string, unknown>();
	const stubFor = (name: string) => ({
		put: async (creds: unknown) => {
			store.set(name, creds);
		},
		get: async () => store.get(name) ?? null,
		clear: async () => {
			store.delete(name);
		},
	});
	return {
		idFromName: (name: string) => name,
		get: (id: string) => stubFor(id),
	} as unknown as DurableObjectNamespace;
}