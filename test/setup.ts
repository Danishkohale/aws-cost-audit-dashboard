/**
 * Test setup — runs before each test file.
 */
import { resetTestDb } from "./sqlite.helper";
import { beforeEach } from "vitest";

beforeEach(() => {
	resetTestDb();
});