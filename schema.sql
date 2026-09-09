-- Reference only — the Worker creates these automatically on first request
-- (see ensureTables in index.js). Included here for manual setup or review.

CREATE TABLE IF NOT EXISTS checklist (
  project_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  power TEXT,
  network TEXT,
  function TEXT,
  updated_by TEXT,
  updated_at TEXT,
  PRIMARY KEY (project_id, device_id)
);

CREATE TABLE IF NOT EXISTS punch (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  device_id TEXT,
  device_name TEXT,
  location TEXT,
  description TEXT,
  severity TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  reported_by TEXT,
  created_at TEXT,
  resolved_by TEXT,
  resolved_at TEXT
);
