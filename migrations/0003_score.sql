-- Scoring feature: each participant can rate the anime they were given
-- (their "given anime") out of 10 via the ⭐ button on their assignment card.
-- Surfaced in the sheet's Score column, the reveal card, the gallery and
-- View Event. NULL = not scored.
--
-- Also as of this revision the sheet drops the Last Edited / Wrote columns
-- and renames Chars → "Review Length" (display only — signups.last_edited /
-- wrote / char_count stay, since wrote-detection still drives reminders and
-- the progress panel).

ALTER TABLE signups ADD COLUMN score INTEGER;
