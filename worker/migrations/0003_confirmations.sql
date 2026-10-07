-- "Is this correct?" on community listings: one row per person per listing,
-- until CONFIRMATIONS_NEEDED people have said yes and the listing is verified.
-- An accepted correction to the listing clears its confirmations (they were
-- about the old details).

CREATE TABLE confirmations (
  restaurant  TEXT NOT NULL,   -- c<id>
  -- The same salted IP fingerprint as everywhere else; one confirmation per
  -- person per listing. Cleared by the nightly purge after 30 days.
  client_hash TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX confirmations_once ON confirmations (restaurant, client_hash);
CREATE INDEX confirmations_client ON confirmations (client_hash, created_at);

ALTER TABLE submissions ADD COLUMN verified_at TEXT;
