-- Shadow listings. Community entries and corrected rest.jdn.co.il listings are
-- now the same thing: a row in `submissions`, corrected field by field.
--
-- A shadow is the row that follows one jdn listing (`shadows` = its post id).
-- `data` is a full copy of that listing as the map shows it, with our accepted
-- corrections applied, kept current by the nightly sync. `corrections` says
-- which fields are ours and what jdn had there when we changed it:
--   { "phone": { "base": "02-53-770-00", "acceptedAt": "..." } }
-- When jdn changes a corrected field, jdn's value wins and the correction is
-- dropped; fields nobody corrected always follow jdn. If jdn removes the
-- listing, the shadow is held for the moderator.
--
-- Replaces the per-field `versions` table, which was empty when this ran.

ALTER TABLE submissions ADD COLUMN shadows TEXT;
ALTER TABLE submissions ADD COLUMN corrections TEXT NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX submissions_shadows ON submissions (shadows) WHERE shadows IS NOT NULL;

DROP TABLE versions;
