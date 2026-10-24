/**
 * Hard-coded price tables — ported verbatim from detailed_audit.py:20-40.
 *
 * All values are rough on-demand USD estimates (Mumbai region, ap-south-1)
 * and are labelled as estimates in the reports. These are the product:
 * keep the numbers identical to the Python source.
 */

/** On-demand Linux, ap-south-1 approx $/mo (730h). */
export const EC2_PRICE_MO: Record<string, number> = {
	"t3.nano": 4,
	"t3.micro": 8,
	"t3.small": 15,
	"t3.medium": 30,
	"t3.large": 60,
	"t3.xlarge": 120,
	"t3.2xlarge": 240,
	"t2.nano": 5,
	"t2.micro": 9,
	"t2.small": 18,
	"t2.medium": 36,
	"t2.large": 72,
	"m5.large": 70,
	"m5.xlarge": 140,
	"m5.2xlarge": 280,
	"m6i.large": 68,
	"c5.large": 62,
	"c5.xlarge": 124,
	"m4.large": 80,
	"c4.large": 70,
	"r4.large": 110,
	"r5.large": 95,
	"m7g.large": 60,
};

/** Single-AZ on-demand approx $/mo (MultiAZ x2 applied separately). */
export const RDS_PRICE_MO: Record<string, number> = {
	"db.t3.micro": 15,
	"db.t3.small": 30,
	"db.t3.medium": 60,
	"db.t3.large": 120,
	"db.m5.large": 150,
	"db.m5.xlarge": 300,
	"db.m6i.large": 145,
	"db.r5.large": 180,
	"db.r6g.large": 170,
	"db.m4.large": 160,
	"db.r4.large": 190,
	"db.t2.micro": 17,
	"db.t2.small": 34,
	"db.t2.medium": 68,
};

export const EBS_GB_MO: Record<string, number> = {
	gp3: 0.08,
	gp2: 0.1,
	io1: 0.125,
	io2: 0.125,
	st1: 0.045,
	sc1: 0.025,
	standard: 0.05,
};

export const SNAP_GB_MO = 0.05;
export const S3_STD_GB_MO = 0.023;
export const CW_INGEST_GB = 0.5;
export const CW_STORE_GB_MO = 0.03;

// Fallback defaults used by the scanners (Python `.get(x, default)`).
export const EC2_PRICE_DEFAULT = 40;
export const RDS_PRICE_DEFAULT = 100;
export const EBS_GB_DEFAULT = 0.08;

/** Look up a monthly price with the same fallback behaviour as the Python scanners. */
export function ec2Price(instanceType: string): number {
	return EC2_PRICE_MO[instanceType] ?? EC2_PRICE_DEFAULT;
}

/** RDS monthly price; MultiAZ doubles the base (matches detailed_audit.py:251). */
export function rdsPrice(instanceClass: string, multiAz: boolean): number {
	return (RDS_PRICE_MO[instanceClass] ?? RDS_PRICE_DEFAULT) * (multiAz ? 2 : 1);
}

/** EBS monthly price for a volume. */
export function ebsPrice(sizeGb: number, volumeType: string): number {
	return sizeGb * (EBS_GB_MO[volumeType] ?? EBS_GB_DEFAULT);
}

// ---------------------------------------------------------------------------
// Savings formulas — the fixed multipliers used across the scanners.
// These must stay identical to the Python source (base * factor, rounded to 2dp).
// ---------------------------------------------------------------------------

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** EC2 idle (<5% CPU) → 60% of base. */
export const savingEc2Idle = (base: number): number => round2(base * 0.6);
/** EC2 underutilized (<15% CPU) → 35% of base. */
export const savingEc2Underutilized = (base: number): number => round2(base * 0.35);
/** RDS stopped → 70% of base. */
export const savingRdsStopped = (base: number): number => round2(base * 0.7);
/** RDS idle → 60% of base. */
export const savingRdsIdle = (base: number): number => round2(base * 0.6);
/** RDS oversized → 40% of base. */
export const savingRdsOversized = (base: number): number => round2(base * 0.4);
/** EBS near-zero I/O → 50% of cost. */
export const savingEbsIdle = (cost: number): number => round2(cost * 0.5);
/** gp2 → gp3 migration → 20% of cost. */
export const savingEbsGp2 = (cost: number): number => round2(cost * 0.2);
/** Snapshot review → 50% of cost. */
export const savingSnapshotReview = (cost: number): number => round2(cost * 0.5);
/** S3 no-lifecycle → min(size_gb * 0.01, 200). */
export const savingS3Lifecycle = (sizeGb: number): number => round2(Math.min(sizeGb * 0.01, 200));
/** S3 versioned-without-expiry → min(cost * 0.4, 100). */
export const savingS3Versioned = (cost: number): number => round2(Math.min(cost * 0.4, 100));
