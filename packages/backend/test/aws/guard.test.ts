import { describe, expect, it } from "vitest";
import {
	DescribeInstancesCommand,
	RunInstancesCommand,
	TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { DeleteSecretCommand } from "@aws-sdk/client-secrets-manager";
import { assertReadOnly, guardClient, isReadOnlyCommand, maskKey } from "../../src/aws/guard";

describe("read-only guard", () => {
	it("allows the commands the audit actually uses", () => {
		expect(isReadOnlyCommand(new DescribeInstancesCommand({}))).toBe(true);
	});

	it("blocks write / destructive commands", () => {
		expect(isReadOnlyCommand(new TerminateInstancesCommand({ InstanceIds: ["i-1"] }))).toBe(false);
		expect(isReadOnlyCommand(new RunInstancesCommand({ MinCount: 1, MaxCount: 1 }))).toBe(false);
		expect(isReadOnlyCommand(new CreateBucketCommand({ Bucket: "x" }))).toBe(false);
		expect(isReadOnlyCommand(new DeleteSecretCommand({ SecretId: "x" }))).toBe(false);
		expect(() => assertReadOnly(new TerminateInstancesCommand({ InstanceIds: ["i-1"] }))).toThrow(
			/READ-ONLY BLOCK/,
		);
	});

	it("blocks non-command objects", () => {
		expect(isReadOnlyCommand({})).toBe(false);
		expect(isReadOnlyCommand(null)).toBe(false);
		expect(isReadOnlyCommand("DescribeInstances")).toBe(false);
	});

	it("guardClient stops a write before it reaches the transport", async () => {
		let sent = 0;
		const client = guardClient({
			send: async (..._args: unknown[]) => {
				sent += 1;
				return {};
			},
		});
		await expect(
			client.send(new RunInstancesCommand({ MinCount: 1, MaxCount: 1 })),
		).rejects.toThrow(/READ-ONLY BLOCK/);
		expect(sent).toBe(0);
	});

	it("maskKey never leaks the key body", () => {
		expect(maskKey("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA****MPLE");
		expect(maskKey("")).toBe("(role-chain)");
		expect(maskKey(undefined)).toBe("(role-chain)");
		expect(maskKey("abc")).toBe("****");
	});
});
