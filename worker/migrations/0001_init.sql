-- Community submissions and reports. Kept entirely apart from the
-- rest.jdn.co.il data: nothing here is written back upstream, and upstream data
-- never lands here.

CREATE TABLE submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- published: passed screening (or approved) and appears on the map.
  -- held:      flagged by screening; waits for the moderator.
  -- rejected:  removed by the moderator.
  status      TEXT    NOT NULL CHECK (status IN ('published', 'held', 'rejected')),
  -- Fields that appear on the map (JSON object).
  data        TEXT    NOT NULL,
  -- Fields only the moderator ever sees, e.g. owner/mashgiach phones (JSON object).
  -- Stored separately so a public query cannot select them by accident.
  private     TEXT    NOT NULL DEFAULT '{}',
  -- Why screening held it (JSON array); [] when it published cleanly.
  flags       TEXT    NOT NULL DEFAULT '[]',
  created_at  TEXT    NOT NULL,
  reviewed_at TEXT,
  review_note TEXT,
  -- SHA-256 of (secret salt, client IP); the raw IP is never stored. Used to
  -- rate-limit and to tell whether two edits came from different people. The
  -- nightly cron clears it after 30 days.
  client_hash TEXT
);

CREATE INDEX submissions_status ON submissions (status, id);
CREATE INDEX submissions_client ON submissions (client_hash, created_at);

-- "Closed / wrong details" reports against any restaurant on the map. These
-- never change data automatically; the moderator acts on them.
CREATE TABLE reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- A rest.jdn.co.il post id, or "c<id>" for a community submission.
  restaurant  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  details     TEXT,
  status      TEXT    NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at  TEXT    NOT NULL,
  reviewed_at TEXT,
  review_note TEXT,
  client_hash TEXT
);

CREATE INDEX reports_status     ON reports (status, id);
CREATE INDEX reports_restaurant ON reports (restaurant);
CREATE INDEX reports_client     ON reports (client_hash, created_at);

-- Edits of rest.jdn.co.il restaurants. One row per submitted edit...
CREATE TABLE edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant  TEXT    NOT NULL,             -- jdn post id
  private     TEXT    NOT NULL DEFAULT '{}',
  flags       TEXT    NOT NULL DEFAULT '[]', -- screening flags; a flagged edit never auto-accepts
  created_at  TEXT    NOT NULL,
  review_note TEXT,
  client_hash TEXT
);

-- ...and one row per field it changes. Each field is decided on its own.
CREATE TABLE edit_fields (
  edit_id     INTEGER NOT NULL REFERENCES edits (id) ON DELETE CASCADE,
  restaurant  TEXT    NOT NULL,
  field       TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  -- jdn's value for this field when the edit was made ('' if jdn has none).
  -- Two edits only confirm each other if they were made against the same one.
  base        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'rejected', 'stale')),
  decided_by  TEXT,                         -- 'corroborated' or 'moderator'
  decided_at  TEXT,
  PRIMARY KEY (edit_id, field)
);

CREATE INDEX edit_fields_match ON edit_fields (restaurant, field, status);
CREATE INDEX edits_client      ON edits (client_hash, created_at);

-- Our saved version of jdn restaurants: accepted values, field by field. A
-- value applies only while jdn's own value for that field still equals `base`;
-- once jdn changes that field, theirs wins and ours is dropped. Other fields
-- of the same restaurant are unaffected.
CREATE TABLE versions (
  restaurant  TEXT    NOT NULL,
  field       TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  base        TEXT    NOT NULL,
  accepted_at TEXT    NOT NULL,
  PRIMARY KEY (restaurant, field)
);
