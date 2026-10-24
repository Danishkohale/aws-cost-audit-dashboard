import { describe, expect, it } from "vitest";
import {
	ebsPrice,
	ec2Price,
	rdsPrice,
	round2,
	savingEbsIdle,
	savingEc2Idle,
	savingRdsOversized,
	savingS3Lifecycle,
} from "../src/rules/pricing";
import { REGION_RE } from "../src/rules/thresholds";
import { money, pyNum } from "../src/report/format";

describe("pricing tables (ported from detailed_audit.py)", () => {
	it("looks up EC2 prices with the Python fallback", () => {
		expect(ec2Price("t3.medium")).toBe(30);
		expect(ec2Price("t2.micro")).toBe(9);
		expect(ec2Price("totally.unknown")).toBe(40); // default
	});

	it("doubles RDS price for MultiAZ", () => {
		expect(rdsPrice("db.m5.large", false)).toBe(150);
		expect(rdsPrice("db.m5.large", true)).toBe(300);
		expect(rdsPrice("db.unknown", false)).toBe(100); // default
	});

	it("computes EBS monthly price per GB", () => {
		expect(ebsPrice(100, "gp3")).toBe(8);
		expect(ebsPrice(100, "gp2")).toBe(10);
		expect(ebsPrice(100, "unknown")).toBe(8); // default 0.08/GB
	});

	it("applies the fixed savings formulas", () => {
		expect(savingEc2Idle(30)).toBe(18); // base * 0.6
		expect(savingRdsOversized(150)).toBe(60); // base * 0.4
		expect(savingEbsIdle(8)).toBe(4); // cost * 0.5
		expect(savingS3Lifecycle(48.2)).toBe(0.48); // min(size*0.01, 200)
		expect(savingS3Lifecycle(30000)).toBe(200); // capped
	});

	it("rounds like Python round(x, 2)", () => {
		expect(round2(1.005)).toBe(1.01);
		expect(round2(143.94000000000003)).toBe(143.94);
	});
});

describe("thresholds", () => {
	it("validates regions exactly like app.py", () => {
		expect(REGION_RE.test("ap-south-1")).toBe(true);
		expect(REGION_RE.test("us-east-1")).toBe(true);
		expect(REGION_RE.test("US-EAST-1")).toBe(false);
		expect(REGION_RE.test("ap-south-")).toBe(false);
		expect(REGION_RE.test("nope")).toBe(false);
	});
});

describe("format helpers", () => {
	it('formats money like Python f"{v:,.2f}"', () => {
		expect(money(182.4)).toBe("182.40");
		expect(money(2)).toBe("2.00");
		expect(money(452.7)).toBe("452.70");
	});

	it("formats raw numbers like Python str(float)", () => {
		expect(pyNum(18)).toBe("18.0");
		expect(pyNum(0.48)).toBe("0.48");
		expect(pyNum(1.46)).toBe("1.46");
	});
});
