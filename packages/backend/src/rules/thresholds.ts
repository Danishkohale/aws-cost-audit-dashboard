/**
 * Detection thresholds — ported verbatim from the Python scanners.
 *
 * Every rule in the audit engine is a hard-coded comparison against one of
 * these constants (see plan.md "Rule engine"). The engine is fully
 * deterministic: no machine learning, no LLM, no randomness.
 */

/** Default CloudWatch lookback window (days). */
export const DEFAULT_LOOKBACK_DAYS = 14;

/** Request validation bounds (app.py:88). */
export const MIN_DAYS = 1;
export const MAX_DAYS = 90;

/** Region validation (app.py:19). */
export const REGION_RE = /^[a-z]{2}-[a-z-]+\d$/;

/** Default region used by the UI and demo (app.py:78). */
export const DEFAULT_REGION = "ap-south-1";

// -- EC2 (cost-optimization.py:195-206 / detailed_audit.py:111-119)
export const EC2_CPU_IDLE_PCT = 5;
export const EC2_CPU_UNDERUTILIZED_PCT = 15;
export const EC2_OLD_GEN_PREFIXES = ["t2.", "m4.", "c4.", "r4."];

// -- EBS (detailed_audit.py:162)
/** read + write ops below this over the window = near-zero I/O. */
export const EBS_LOW_IO_OPS = 100;

// -- Snapshots (detailed_audit.py:219-228)
export const SNAP_OLD_AGE_DAYS = 90;
export const SNAP_REVIEW_AGE_DAYS = 30;
export const SNAP_REVIEW_MIN_GB = 50;
export const SNAP_SCAN_CAP = 60;

// -- RDS (detailed_audit.py:271-278)
export const RDS_CPU_IDLE_PCT = 5;
export const RDS_CONNS_IDLE = 5;
export const RDS_CPU_OVERSIZED_PCT = 15;
export const RDS_OLD_CLASS_MARKERS = ["m4", "r4", "t2"];

// -- ELB (detailed_audit.py:479-485)
export const ELB_REQUEST_THRESHOLD = 1000;

// -- VPC (detailed_audit.py:417-424)
/** NAT gateway traffic below this (GB) over the window = idle. */
export const NAT_IDLE_GB = 1;
export const NAT_REVIEW_GB = 50;

// -- EKS (cost-optimization.py:340)
export const EKS_MIN_SUPPORTED_VERSION = "1.28";

// -- Secrets Manager (cost-optimization.py:375)
export const SECRET_STALE_DAYS = 90;

// -- CloudWatch (detailed_audit.py:378-386)
export const CW_STORED_GB_MIN = 1;
export const CW_HIGH_INGEST_GB_DAY = 5;
export const CW_SCAN_CAP = 80;

// -- S3 (detailed_audit.py:331-343)
export const S3_EMPTY_MAX_GB = 0.1;
export const S3_LOW_REQUESTS = 100;
export const S3_LIFECYCLE_MIN_GB = 1;
export const S3_SCAN_CAP = 100;

// -- Fixed monthly costs referenced by rules
export const COST_NAT_GATEWAY_MO = 32;
export const COST_EIP_MO = 3.65;
export const COST_EKS_CONTROL_PLANE_MO = 73;
export const COST_VPN_MO = 36;
export const COST_ELB_MO = 20;
export const COST_SECRET_MO = 0.4;
