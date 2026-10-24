-- Job metadata + findings for the AWS cost audit.
--
-- Replaces the Python module-level `JOBS` dict (app.py:22) and the on-disk
-- `reports/` directory. Findings are stored as rows (not one giant JSON blob) so
-- each bounded chunk of an audit writes incrementally instead of a single 200 KB+
-- statement (D1 caps bound parameters at 100 per query).

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,                  -- queued | running | done | error
  progress    INTEGER NOT NULL DEFAULT 0,
  logs        TEXT NOT NULL DEFAULT '[]',     -- JSON array (cap 200 stored)
  summary     TEXT,                           -- JSON, written at finalize
  cost        TEXT,                           -- JSON live_cost_by_service
  cost_note   TEXT,
  error       TEXT,
  region      TEXT,
  days        INTEGER,
  step        TEXT,                           -- last completed step name
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX jobs_created_at ON jobs(created_at);

CREATE TABLE findings (
  job_id         TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  service        TEXT NOT NULL,
  resource       TEXT NOT NULL,
  category       TEXT NOT NULL,
  detail         TEXT NOT NULL,
  saving         REAL NOT NULL DEFAULT 0,
  recommendation TEXT NOT NULL,
  meta           TEXT,                        -- JSON, deep-layer rows only
  PRIMARY KEY (job_id, seq)
);

CREATE INDEX findings_job ON findings(job_id);
