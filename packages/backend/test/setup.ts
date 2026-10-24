/**
 * Test setup — runs before each test file.
 */
import { resetTestDb, createTestDb as createTestDbHelper } from "./sqlite.helper";
import { beforeEach } from "vitest";

beforeEach(() => {
	resetTestDb();
	createTestDbHelper(); // This also sets the test DB for routes
});